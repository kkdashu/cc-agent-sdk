#!/bin/bash
# restart.sh - 守护进程：监控 feishu-agent，自动重启
# 当 bot 以退出码 42 退出时，先 git pull 再重启

set -e
cd "$(dirname "$0")"

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 feishu-agent..."
  bun feishu-agent.ts
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 42 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 收到更新信号，执行 git pull..."
    git pull origin main
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 更新完成，重启中..."
  elif [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 正常退出，停止守护。"
    break
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 异常退出(码=$EXIT_CODE)，3秒后重启..."
    sleep 3
  fi
done
