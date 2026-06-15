#!/usr/bin/env bash
# 停掉 RAGFlow 全家桶。加 --purge 连数据卷一起删（慎用，会清空已灌的知识库）。
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && { set -a; . ./.env; set +a; }
WORKDIR="${RAGFLOW_DEPLOY_DIR:-$HOME/ragflow}"
cd "$WORKDIR/docker"
if [ "${1:-}" = "--purge" ]; then
  docker compose -f docker-compose.yml down -v
  echo "已停止并清空数据卷。"
else
  docker compose -f docker-compose.yml down
  echo "已停止（数据卷保留，再次 ./setup.sh 即可恢复）。"
fi
