"""Local semantic retrieval over the sales playbook.

Primary backend: local sentence-embeddings via `fastembed` (BGE small zh, ONNX,
CPU-friendly). If the model can't be loaded (offline / not installed), we fall
back to a jieba + TF-IDF cosine retriever so retrieval always works without any
network or API key.

Both backends expose the same `search(query, k)` returning citable snippets.
"""

from __future__ import annotations

import json
import math
import os
import re
from collections import Counter
from functools import lru_cache
from typing import Any

from .knowledge import PLAYBOOK

# Crawled public sales knowledge (scripts/scrapling_crawl.py --merge-playbook)
# is folded into the corpus at startup so it is actually used by retrieval.
_CRAWLED_PATH = os.path.join(os.path.dirname(__file__), "data", "crawled_knowledge.jsonl")


def _load_corpus() -> list[dict[str, str]]:
    """PLAYBOOK + any crawled public-knowledge entries on disk (deduped by id)."""
    corpus = list(PLAYBOOK)
    seen = {d["id"] for d in corpus}
    if os.path.exists(_CRAWLED_PATH):
        with open(_CRAWLED_PATH, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("id") and entry["id"] not in seen and entry.get("text"):
                    seen.add(entry["id"])
                    corpus.append(
                        {
                            "id": entry["id"],
                            "topic": entry.get("topic", "公开销售知识"),
                            "title": entry.get("title", ""),
                            "text": entry["text"],
                            "source": entry.get("source", ""),
                        }
                    )
    return corpus


def _tokenize(text: str) -> list[str]:
    """Lightweight CJK-aware tokenizer: each Chinese char + ascii words."""
    text = text.lower()
    tokens: list[str] = []
    for m in re.finditer(r"[a-z0-9]+|[\u4e00-\u9fff]", text):
        tokens.append(m.group(0))
    # add Chinese bigrams to capture short phrases
    chars = [t for t in tokens if "\u4e00" <= t <= "\u9fff"]
    tokens.extend(chars[i] + chars[i + 1] for i in range(len(chars) - 1))
    return tokens


class _TfidfRetriever:
    """Deterministic offline fallback retriever (vector cosine over TF-IDF)."""

    def __init__(self, docs: list[dict[str, str]]):
        self.docs = docs
        self.doc_tokens = [_tokenize(d["title"] + " " + d["text"]) for d in docs]
        df: Counter[str] = Counter()
        for toks in self.doc_tokens:
            df.update(set(toks))
        n = len(docs)
        self.idf = {t: math.log((n + 1) / (c + 1)) + 1 for t, c in df.items()}
        self.doc_vecs = [self._vec(toks) for toks in self.doc_tokens]

    def _vec(self, tokens: list[str]) -> dict[str, float]:
        tf = Counter(tokens)
        vec = {t: (c / len(tokens)) * self.idf.get(t, 0.0) for t, c in tf.items() if tokens}
        norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
        return {t: v / norm for t, v in vec.items()}

    def search(self, query: str, k: int) -> list[dict[str, Any]]:
        qvec = self._vec(_tokenize(query))
        scored: list[tuple[float, int]] = []
        for i, dvec in enumerate(self.doc_vecs):
            score = sum(qvec.get(t, 0.0) * w for t, w in dvec.items())
            scored.append((score, i))
        scored.sort(reverse=True)
        out = []
        for score, i in scored[:k]:
            if score <= 0:
                continue
            d = self.docs[i]
            out.append({**d, "score": round(float(score), 4), "backend": "tfidf"})
        return out


class _EmbeddingRetriever:
    """Vector retriever backed by fastembed (BGE small zh)."""

    def __init__(self, docs: list[dict[str, str]], model: Any):
        self.docs = docs
        self.model = model
        texts = [d["title"] + "。" + d["text"] for d in docs]
        self.doc_vecs = list(self.model.embed(texts))

    @staticmethod
    def _cos(a: Any, b: Any) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a)) or 1.0
        nb = math.sqrt(sum(y * y for y in b)) or 1.0
        return dot / (na * nb)

    def search(self, query: str, k: int) -> list[dict[str, Any]]:
        qvec = next(iter(self.model.embed([query])))
        scored = sorted(
            ((self._cos(qvec, dv), i) for i, dv in enumerate(self.doc_vecs)),
            reverse=True,
        )
        out = []
        for score, i in scored[:k]:
            d = self.docs[i]
            out.append({**d, "score": round(float(score), 4), "backend": "embedding"})
        return out


class _RagflowRetriever:
    """Multimodal RAG backend backed by a local RAGFlow deployment.

    Used only when ``RAGFLOW_API_URL`` / ``RAGFLOW_API_KEY`` / ``RAGFLOW_DATASET_ID``
    are configured *and* the retrieval endpoint answers a probe. RAGFlow lets the
    knowledge base hold images / video / docs, not just text — so the same query
    can surface multimodal assets. Any failure falls back to the local vector
    retriever so the closer never blocks on RAGFlow being up.
    """

    def __init__(self, base_url: str, api_key: str, dataset_id: str):
        import requests  # local import: only needed on this path

        self._requests = requests
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.dataset_ids = [d.strip() for d in dataset_id.split(",") if d.strip()]

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def probe(self) -> bool:
        try:
            r = self._requests.get(
                f"{self.base_url}/api/v1/datasets", headers=self._headers(), timeout=5
            )
            return r.status_code == 200
        except Exception:  # noqa: BLE001
            return False

    def search(self, query: str, k: int) -> list[dict[str, Any]]:
        try:
            r = self._requests.post(
                f"{self.base_url}/api/v1/retrieval",
                headers=self._headers(),
                json={
                    "question": query,
                    "dataset_ids": self.dataset_ids,
                    "top_k": max(k * 4, 16),
                    "page_size": k,
                    "similarity_threshold": 0.1,
                },
                timeout=20,
            )
            chunks = (r.json().get("data") or {}).get("chunks") or []
        except Exception:  # noqa: BLE001
            return _fallback_retriever().search(query, k)
        out: list[dict[str, Any]] = []
        for c in chunks[:k]:
            out.append(
                {
                    "id": c.get("id", ""),
                    "title": c.get("document_keyword") or c.get("docnm_kwd") or "RAGFlow",
                    "text": c.get("content") or c.get("content_with_weight") or "",
                    "score": round(float(c.get("similarity", 0.0)), 4),
                    "backend": "ragflow",
                }
            )
        return out


@lru_cache(maxsize=1)
def _fallback_retriever() -> Any:
    corpus = _load_corpus()
    try:
        from fastembed import TextEmbedding  # type: ignore

        model = TextEmbedding(model_name="BAAI/bge-small-zh-v1.5")
        return _EmbeddingRetriever(corpus, model)
    except Exception:  # noqa: BLE001 — any failure → deterministic fallback
        return _TfidfRetriever(corpus)


@lru_cache(maxsize=1)
def _get_retriever() -> Any:
    url = os.getenv("RAGFLOW_API_URL", "").strip()
    key = os.getenv("RAGFLOW_API_KEY", "").strip()
    dataset = os.getenv("RAGFLOW_DATASET_ID", "").strip()
    if url and key and dataset:
        rf = _RagflowRetriever(url, key, dataset)
        if rf.probe():
            return rf
    return _fallback_retriever()


def retrieve(query: str, k: int = 4) -> list[dict[str, Any]]:
    """Return up to k citable playbook snippets most relevant to the query."""
    if not query.strip():
        return []
    return _get_retriever().search(query, k)


def retrieval_backend() -> str:
    r = _get_retriever()
    if isinstance(r, _RagflowRetriever):
        return "ragflow"
    return "embedding" if isinstance(r, _EmbeddingRetriever) else "tfidf"
