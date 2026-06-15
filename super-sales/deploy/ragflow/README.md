# RAGFlow 多模态 RAG · 一键部署

把本地 [RAGFlow](https://github.com/infiniflow/ragflow) 作为 AI 超级销售的多模态知识库
（可存文本/图片/视频/文档），并自动把 **销冠方法论库 + 已爬取的公开销售知识** 灌进去。

检索后端是**可插拔**的：配好 `RAGFLOW_*` 就用 RAGFlow，否则自动回退到本地 BGE 向量
（`super-sales/backend/app/retrieval.py`），任何时候都不会因为 RAGFlow 没起来而阻塞。

## 一键启动

```bash
cd super-sales/deploy/ragflow
cp .env.example .env      # 按需改内存/端口/账号；低内存机器保持 ES_MEM_LIMIT=2g
./setup.sh                # 拉起全家桶 + 装 Ollama(bge-m3) + 灌库
```

`setup.sh` 做了 5 件事：

1. 按 `.env` 里固定的 `RAGFLOW_VERSION` 克隆官方部署文件到 `~/ragflow`。
2. `docker compose up -d` 拉起 `es + mysql + minio + redis + ragflow`，并把 ES 内存压到 `ES_MEM_LIMIT`。
3. 安装并启动 Ollama（监听 `0.0.0.0`，容器可达），拉取 `bge-m3` embedding 模型（免 key、多模态友好）。
4. 运行 `scripts/ragflow_ingest.py`：注册服务账号 → 签发 API key → 建「销冠方法论库」→ 上传全部条目并触发解析。
5. 打印要写进 `super-sales/backend/.env` 的三行：

   ```
   RAGFLOW_API_URL=http://localhost:9380
   RAGFLOW_API_KEY=ragflow-xxxxxxxx
   RAGFLOW_DATASET_ID=xxxxxxxx
   ```

把这三行写进 `backend/.env`，重启后端即生效。

## 关停 / 清理

```bash
./teardown.sh           # 停服务，保留数据卷
./teardown.sh --purge   # 连数据卷一起删（会清空已灌知识库）
```

## 内存说明（重要）

RAGFlow 官方建议 16GB+。在 8GB 左右的机器上，本配置把 Elasticsearch 内存压到 2GB 可以跑起来，
但偏紧、偶发变慢。生产建议 16GB+ 或换 hosted embedding（见 `.env.example` 注释）。

## 换用 hosted embedding（不想本地跑 Ollama）

在 `.env` 里把 `OLLAMA_MODEL` 留空，填 `RAGFLOW_EMBED_FACTORY/MODEL/API_KEY/BASE_URL`
（如 OpenAI 的 `text-embedding-3-small`），再跑 `./setup.sh`。

## 灌入更多公开知识

```bash
cd super-sales/backend
.venv/bin/python -m scripts.scrapling_crawl --builtin --crawl --max-pages 40 --merge-playbook
.venv/bin/python -m scripts.ragflow_ingest --base http://localhost:9380 --ollama-model bge-m3
```

`scrapling_crawl.py` 只爬公开页面、遵守 `robots.txt`、保留来源 URL 作署名，不二次公开分发。
