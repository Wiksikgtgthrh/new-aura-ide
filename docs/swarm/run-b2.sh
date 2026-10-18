#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd /c/new-aura-ide/vscode-main
opencode run -m dashscope/kimi-k3 "$(cat docs/swarm/PROMPT-b2-n8n-market.md)" 2>&1 | tee docs/swarm/b2.log
echo "=== B2 ЗАВЕРШЁН, код $? ==="
read -r -p "Enter — закрыть вкладку"
