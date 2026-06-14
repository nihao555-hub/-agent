"""Local semantic retrieval over the sales playbook.

Primary backend: local sentence-embeddings via `fastembed` (BGE small zh, ONNX,
CPU-friendly). If the model can't be loaded (offline / not installed), we fall
back to a jieba + TF-IDF cosine retriever so retrieval always works without any
network or API key.

Both backends expose the same `search(query, k)` returning citable snippets.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from functools import lru_cache
from typing import Any

from .knowledge import PLAYBOOK


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


@lru_cache(maxsize=1)
def _get_retriever() -> Any:
    try:
        from fastembed import TextEmbedding  # type: ignore

        model = TextEmbedding(model_name="BAAI/bge-small-zh-v1.5")
        return _EmbeddingRetriever(PLAYBOOK, model)
    except Exception:  # noqa: BLE001 — any failure → deterministic fallback
        return _TfidfRetriever(PLAYBOOK)


def retrieve(query: str, k: int = 4) -> list[dict[str, Any]]:
    """Return up to k citable playbook snippets most relevant to the query."""
    if not query.strip():
        return []
    return _get_retriever().search(query, k)


def retrieval_backend() -> str:
    r = _get_retriever()
    return "embedding" if isinstance(r, _EmbeddingRetriever) else "tfidf"
