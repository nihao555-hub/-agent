"""本地嵌入微服务（OpenAI 兼容 /v1/embeddings）。

为 RAGFlow / eng-delivery 后端提供**全离线**的语义向量，无需任何外部 key。
模型：BAAI/bge-small-zh-v1.5（fastembed / onnxruntime，CPU，512 维），中文/多语种通用。

RAGFlow 接法：Model providers → OpenAI-API-Compatible → Embedding
  - Base URL: http://host.docker.internal:8000/v1
  - Model name: bge-small-zh
  - API key: 任意非空（本服务不校验）
"""

from __future__ import annotations

import os
from typing import List, Union

import numpy as np
from fastapi import FastAPI
from fastembed import TextEmbedding
from pydantic import BaseModel

MODEL_NAME = os.environ.get("EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
SERVED_AS = os.environ.get("EMBED_SERVED_AS", "bge-small-zh")

app = FastAPI(title="eng-delivery embedding service", version="0.1.0")
_model: TextEmbedding | None = None


def get_model() -> TextEmbedding:
    global _model
    if _model is None:
        _model = TextEmbedding(model_name=MODEL_NAME)
    return _model


class EmbeddingRequest(BaseModel):
    input: Union[str, List[str]]
    model: str | None = None


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "served_as": SERVED_AS}


@app.post("/v1/embeddings")
def embeddings(req: EmbeddingRequest) -> dict:
    texts = [req.input] if isinstance(req.input, str) else list(req.input)
    vectors = [np.asarray(v, dtype=float).tolist() for v in get_model().embed(texts)]
    data = [
        {"object": "embedding", "index": i, "embedding": v}
        for i, v in enumerate(vectors)
    ]
    total = sum(len(t) for t in texts)
    return {
        "object": "list",
        "data": data,
        "model": req.model or SERVED_AS,
        "usage": {"prompt_tokens": total, "total_tokens": total},
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("RAG_PORT", "8000")))
