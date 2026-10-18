#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd /c/new-aura-ide/vscode-main
opencode run -m dashscope/glm-5.3-prime "$(cat docs/swarm/PROMPT-zan-b1.md)" 2>&1 | tee docs/swarm/zan-b1.log
echo "=== zan-b1 ЗАВЕРШЕНО ==="
read -r -p "Enter — закрыть вкладку"
