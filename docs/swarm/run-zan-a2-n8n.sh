#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd "/c/new-aura-ide/vscode-main"
opencode run -m dashscope/glm-5.3-prime "$(cat docs/swarm/PROMPT-zan-a2-n8n.md)" 2>&1 | tee docs/swarm/zan-a2-n8n.log
echo "=== zan-a2-n8n ЗАВЕРШЕНО ==="
read -r -p "Enter — закрыть вкладку"
