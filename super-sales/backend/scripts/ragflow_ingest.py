#!/usr/bin/env python3
"""Provision a local RAGFlow deployment for the AI Super Sales closer.

What it does (idempotent, best-effort):
  1. Register / log in a service account on RAGFlow.
  2. Mint (or reuse) an HTTP API key.
  3. (Optional) Attach an embedding provider from env so a knowledge base can
     embed text — RAGFlow needs *some* embedding model; this image ships none
     offline, so you must point it at one (a hosted embedding key, or a local
     Ollama / Xinference). See ``--embed-*`` flags / env below.
  4. Create the "销冠方法论库" knowledge base.
  5. Upload all 102 playbook entries (one doc per stable ID, so citations stay
     traceable) and trigger parsing.
  6. Print the ``RAGFLOW_*`` lines to drop into ``backend/.env`` — once set, the
     closer's retrieval flips from local BGE to RAGFlow automatically.

The RSA public key below is RAGFlow's *shipped, non-secret* login key (identical
across installs); the password is only ever sent RSA-encrypted.

Usage:
    python -m scripts.ragflow_ingest \
        --base http://localhost:9380 \
        --embed-factory OpenAI --embed-model text-embedding-3-small \
        --embed-key sk-... --embed-base-url https://api.openai.com/v1

Run with no ``--embed-*`` if you have already configured an embedding model in
the RAGFlow web UI (then pass ``--embed-model <name@Factory>``).
"""

from __future__ import annotations

import argparse
import base64
import os
import sys
import time

import requests
from Crypto.Cipher import PKCS1_v1_5
from Crypto.PublicKey import RSA

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.retrieval import _load_corpus  # noqa: E402  (PLAYBOOK + crawled public knowledge)

RAGFLOW_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArq9XTUSeYr2+N1h3Afl/
z8Dse/2yD0ZGrKwx+EEEcdsBLca9Ynmx3nIB5obmLlSfmskLpBo0UACBmB5rEjBp
2Q2f3AG3Hjd4B+gNCG6BDaawuDlgANIhGnaTLrIqWrrcm4EMzJOnAOI1fgzJRsOO
UEfaS318Eq9OVO3apEyCCt0lOQK6PuksduOjVxtltDav+guVAA068NrPYmRNabVK
RNLJpL8w4D44sfth5RvZ3q9t+6RTArpEtc5sh5ChzvqPOzKGMXW83C95TxmXqpbK
6olN4RevSfVjEAgCydH6HN6OhtOQEcnrU97r9H0iZOWwbw3pVrZiUkuRD1R56Wzs
2wIDAQAB
-----END PUBLIC KEY-----"""


def _encrypt(password: str) -> str:
    cipher = PKCS1_v1_5.new(RSA.importKey(RAGFLOW_PUBLIC_KEY))
    return base64.b64encode(cipher.encrypt(password.encode())).decode()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.getenv("RAGFLOW_BASE", "http://localhost:9380"))
    ap.add_argument("--email", default=os.getenv("RAGFLOW_EMAIL", "agent@super-sales.local"))
    ap.add_argument("--password", default=os.getenv("RAGFLOW_PASSWORD", "SuperSales#2026"))
    ap.add_argument("--dataset-name", default="销冠方法论库")
    ap.add_argument("--embed-factory", default=os.getenv("RAGFLOW_EMBED_FACTORY", ""))
    ap.add_argument("--embed-model", default=os.getenv("RAGFLOW_EMBED_MODEL", ""))
    ap.add_argument("--embed-key", default=os.getenv("RAGFLOW_EMBED_API_KEY", ""))
    ap.add_argument("--embed-base-url", default=os.getenv("RAGFLOW_EMBED_BASE_URL", ""))
    # Local Ollama embedding (recommended, no key). RAGFlow runs in Docker, so the
    # base URL must be reachable *from the container* (host.docker.internal works
    # once Ollama listens on 0.0.0.0).
    ap.add_argument("--ollama-model", default=os.getenv("RAGFLOW_OLLAMA_MODEL", ""))
    ap.add_argument(
        "--ollama-base",
        default=os.getenv("RAGFLOW_OLLAMA_BASE", "http://host.docker.internal:11434"),
    )
    args = ap.parse_args()

    api = f"{args.base.rstrip('/')}/api/v1"          # SDK API (Bearer api key)
    s = requests.Session()
    pw = _encrypt(args.password)

    # 1) register or login
    r = s.post(f"{api}/users", json={"nickname": "SuperSalesAgent", "email": args.email, "password": pw})
    if "already registered" in r.text or r.json().get("code") != 0:
        r = s.post(f"{api}/auth/login", json={"email": args.email, "password": pw})
        if r.json().get("code") != 0:
            print("login failed:", r.text[:200])
            return 1
    s.headers["Authorization"] = r.headers.get("Authorization", "")
    print("[ok] authenticated as", args.email)

    # 2) mint API key
    r = s.post(f"{api}/system/tokens")
    api_key = r.json().get("data", {}).get("token", "")
    if not api_key:
        print("token mint failed:", r.text[:200])
        return 1
    hk = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    print("[ok] api key minted")

    # 3) register an embedding model via the provider/instance/model API
    #    (RAGFlow v0.26+). The default-instance convention is "{model}@{Factory}".
    def _register(factory: str, model: str, api_key: str, base_url: str) -> str:
        # Provider/instance/model model (v0.26+): an instance bundles its models
        # at creation and is verified against the live endpoint. "default" is a
        # reserved instance name, so we use "local"; identifier is model@inst@factory.
        instance = "local"
        s.put(f"{api}/providers", json={"provider_name": factory})
        rr = s.post(
            f"{api}/providers/{factory}/instances",
            json={
                "instance_name": instance,
                "api_key": api_key or "x",
                "base_url": base_url or "",
                "model_info": [
                    {"model_type": ["embedding"], "model_name": model, "max_tokens": 8192}
                ],
            },
        )
        if rr.json().get("code") not in (0, None):
            print(f"[warn] register {model}@{instance}@{factory} failed:", rr.text[:240])
        ident = f"{model}@{instance}@{factory}"
        s.patch(
            f"{api}/models/default",
            json={
                "model_provider": factory,
                "model_instance": instance,
                "model_name": model,
                "model_type": "embedding",
            },
        )
        print(f"[ok] registered + defaulted embedding {ident}")
        return ident

    if args.ollama_model:
        # Local Ollama (recommended, no key). Base URL must be reachable from the
        # RAGFlow *container* — host.docker.internal works once Ollama binds 0.0.0.0.
        args.embed_model = _register("Ollama", args.ollama_model, "ollama", args.ollama_base)
    elif args.embed_factory and args.embed_key:
        # Hosted provider (OpenAI / Jina / SILICONFLOW…).
        args.embed_model = _register(
            args.embed_factory, args.embed_model, args.embed_key, args.embed_base_url
        )

    # 4) create dataset
    body: dict[str, object] = {"name": args.dataset_name}
    if args.embed_model:
        body["embedding_model"] = args.embed_model
    r = requests.post(f"{api}/datasets", headers=hk, json=body)
    data = r.json()
    if data.get("code") != 0:
        # maybe it already exists — look it up
        existing = requests.get(f"{api}/datasets", headers=hk, params={"name": args.dataset_name}).json()
        rows = existing.get("data") or []
        if not rows:
            print("dataset create failed (need an embedding model configured):", r.text[:300])
            print("→ configure an embedding model in RAGFlow first, then re-run with --embed-model")
            return 2
        dataset_id = rows[0]["id"]
    else:
        dataset_id = data["data"]["id"]
    print("[ok] dataset:", dataset_id)

    # 5) upload playbook docs (one per stable ID) + parse
    doc_ids: list[str] = []
    batch: list[tuple[str, tuple[str, bytes, str]]] = []

    def flush() -> None:
        if not batch:
            return
        rr = requests.post(f"{api}/datasets/{dataset_id}/documents", headers={"Authorization": f"Bearer {api_key}"}, files=batch)
        for d in rr.json().get("data") or []:
            doc_ids.append(d["id"])
        batch.clear()

    corpus = _load_corpus()
    for e in corpus:
        src = f"\n\n> 来源：{e['source']}" if e.get("source") else ""
        content = f"# [{e['id']}] {e['title']}（{e['topic']}）\n\n{e['text']}{src}\n".encode()
        batch.append(("file", (f"{e['id']}.md", content, "text/markdown")))
        if len(batch) >= 20:
            flush()
    flush()
    print(f"[ok] uploaded {len(doc_ids)} docs (PLAYBOOK + crawled public knowledge)")

    if doc_ids:
        requests.post(f"{api}/datasets/{dataset_id}/documents/parse", headers=hk, json={"document_ids": doc_ids})
        print("[ok] parsing triggered (embedding runs async)")

    print("\n# --- add these to backend/.env ---")
    print(f"RAGFLOW_API_URL={args.base.rsplit(':', 1)[0] if args.base.endswith(':9380') else args.base}")
    print(f"RAGFLOW_API_KEY={api_key}")
    print(f"RAGFLOW_DATASET_ID={dataset_id}")
    time.sleep(0.1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
