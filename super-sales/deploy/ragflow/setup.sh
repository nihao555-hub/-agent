#!/usr/bin/env bash
# ── AI 超级销售 · RAGFlow 多模态 RAG 一键部署 ────────────────────────────────
# 拉起本地 RAGFlow（es + mysql + minio + redis + ragflow），并（默认）装好本地
# Ollama + bge-m3 作为 embedding，最后把销冠方法论库 + 已爬取的公开销售知识灌进去。
#
# 用法：
#   cp .env.example .env   # 按需改内存/端口/账号
#   ./setup.sh             # 一键部署 + 灌库
#
# 幂等：可重复执行；已存在的容器/模型/知识库会复用，不会重复建。
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || cp .env.example .env
set -a; . ./.env; set +a

WORKDIR="${RAGFLOW_DEPLOY_DIR:-$HOME/ragflow}"
BACKEND="$(cd ../../backend && pwd)"

echo "==> 1/5 准备 RAGFlow ${RAGFLOW_VERSION} 部署文件 (${WORKDIR})"
if [ ! -d "$WORKDIR/.git" ]; then
  git clone --depth 1 --branch "${RAGFLOW_VERSION}" https://github.com/infiniflow/ragflow.git "$WORKDIR"
fi
cd "$WORKDIR/docker"

# 适配低内存机器：把 ES 内存上限压到 .env 配置值。
if grep -q '^MEM_LIMIT=' .env 2>/dev/null; then
  sed -i "s/^MEM_LIMIT=.*/MEM_LIMIT=${ES_MEM_LIMIT}/" .env
else
  echo "MEM_LIMIT=${ES_MEM_LIMIT}" >> .env
fi

echo "==> 2/5 docker compose 拉起 RAGFlow 全家桶（首次拉镜像较慢）"
docker compose -f docker-compose.yml up -d
echo "    等待 RAGFlow 就绪 ..."
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${RAGFLOW_PORT}/v1/user/info" >/dev/null 2>&1 \
     || curl -fsS "http://localhost:${RAGFLOW_PORT}" >/dev/null 2>&1; then
    echo "    RAGFlow 已响应。"; break
  fi
  sleep 5
done

if [ -n "${OLLAMA_MODEL:-}" ]; then
  echo "==> 3/5 安装并启动 Ollama，拉取 embedding 模型 ${OLLAMA_MODEL}"
  bash "$(dirname "$BACKEND")/deploy/ragflow/ollama.sh" "${OLLAMA_MODEL}"
else
  echo "==> 3/5 跳过本地 Ollama（OLLAMA_MODEL 为空，将用 hosted embedding key）"
fi

echo "==> 4/5 安装后端依赖并灌库（销冠方法论 + 已爬取公开知识）"
cd "$BACKEND"
if [ ! -x .venv/bin/python ]; then
  uv venv .venv && uv pip install -p .venv/bin/python -r requirements.txt
fi

INGEST_ARGS=(--base "http://localhost:${RAGFLOW_PORT}" \
  --email "${RAGFLOW_EMAIL}" --password "${RAGFLOW_PASSWORD}")
if [ -n "${OLLAMA_MODEL:-}" ]; then
  INGEST_ARGS+=(--ollama-model "${OLLAMA_MODEL}" --ollama-base "${OLLAMA_BASE}")
elif [ -n "${RAGFLOW_EMBED_MODEL:-}" ]; then
  INGEST_ARGS+=(--embed-factory "${RAGFLOW_EMBED_FACTORY}" --embed-model "${RAGFLOW_EMBED_MODEL}" \
    --embed-key "${RAGFLOW_EMBED_API_KEY}" --embed-base-url "${RAGFLOW_EMBED_BASE_URL}")
fi
.venv/bin/python -m scripts.ragflow_ingest "${INGEST_ARGS[@]}" | tee /tmp/ragflow_ingest.out

echo "==> 5/5 完成。把上面打印的 RAGFLOW_API_URL/KEY/DATASET_ID 写进 backend/.env，"
echo "    检索后端会自动从本地 BGE 切换到 RAGFlow（失败自动回退，绝不阻塞）。"
echo "    RAGFlow Web UI: http://localhost:${RAGFLOW_PORT}"
