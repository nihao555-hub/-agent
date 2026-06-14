#!/usr/bin/env bash
# 安装/启动 Ollama 并拉取 embedding 模型（默认 bge-m3，多模态友好、免 key）。
# 关键点：让 Ollama 监听 0.0.0.0，RAGFlow 容器才能经 host.docker.internal 访问。
set -euo pipefail
MODEL="${1:-bge-m3}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "[ollama] 安装中 ..."
  # 官方安装脚本需要 zstd 解包
  if ! command -v zstd >/dev/null 2>&1; then
    sudo apt-get update -y >/dev/null 2>&1 || true
    sudo apt-get install -y zstd >/dev/null 2>&1 || true
  fi
  curl -fsSL https://ollama.com/install.sh | sh
fi

# 让服务监听所有网卡（容器可达）。systemd 环境用 override，否则直接后台起。
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^ollama.service'; then
  sudo mkdir -p /etc/systemd/system/ollama.service.d
  printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n' \
    | sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl restart ollama
else
  pgrep -x ollama >/dev/null 2>&1 || (OLLAMA_HOST=0.0.0.0:11434 nohup ollama serve >/tmp/ollama.log 2>&1 &)
fi
sleep 3

echo "[ollama] 拉取模型 ${MODEL} ..."
ollama pull "${MODEL}"
echo "[ollama] 就绪：$(curl -fsS http://localhost:11434/api/version 2>/dev/null || echo '?')"
