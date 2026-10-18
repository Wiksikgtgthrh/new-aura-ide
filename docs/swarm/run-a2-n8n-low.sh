#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd /c/new-aura-ide/vscode-main
opencode run -m dashscope/qwen3.8-flash "$(cat docs/swarm/PROMPT-a2-n8n-low.md)" 2>&1 | tee docs/swarm/a2-n8n-low.log
echo "=== a2-n8n-low ЗАВЕРШЁН ==="
read -r -p "Enter — закрыть вкладку"
