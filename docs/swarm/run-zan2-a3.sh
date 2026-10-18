#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd "/c/new-aura-ide/vscode-main"
opencode run -m dashscope/glm-5.3-prime "$(cat docs/swarm/PROMPT-zan2-a3.md)" 2>&1 | tee docs/swarm/zan2-a3.log
echo "=== zan2-a3 ЗАВЕРШЕНО ==="
read -r -p "Enter — закрыть вкладку"
