# rag-service · 本地嵌入微服务

为 RAGFlow 和 eng-delivery 后端提供**全离线**的 OpenAI 兼容嵌入（无需外部 key）。
模型 BAAI/bge-small-zh-v1.5（fastembed / onnxruntime，CPU，512 维）。

## 运行

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python app.py          # 监听 0.0.0.0:8000
curl localhost:8000/health
```

## 接入 RAGFlow

Model providers → **OpenAI-API-Compatible** → 添加 Embedding 模型：
- Model name: `bge-small-zh`
- Base URL: `http://host.docker.internal:8000/v1`
- API key: 任意非空（本服务不校验）

然后在「Set default models」把 Embedding 设为它。
