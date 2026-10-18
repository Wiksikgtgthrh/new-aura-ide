#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd "/c/new-aura-ide/vscode-main"
opencode run -m dashscope/qwen3.8-flash "$(cat docs/swarm/PROMPT-a2-n8n-fix.md)" 2>&1 | tee docs/swarm/a2-n8n-fix.log
echo "=== a2-n8n-fix ЗАВЕРШЁН ==="
read -r -p "Enter — закрыть вкладку"
