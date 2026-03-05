#!/bin/bash
# restart.sh - 崩溃守护：feishu-agent 异常退出时自动重启
# 正常退出(0) 或 主动自更新后的退出 均不重启

cd "$(dirname "$0")"

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 feishu-agent..."
  bun feishu-agent.ts
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 正常退出，停止守护。"
    break
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 异常退出(码=$EXIT_CODE)，3秒后重启..."
    sleep 3
  fi
done
