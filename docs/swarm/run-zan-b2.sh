#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd /c/new-aura-ide/vscode-main
opencode run -m dashscope/glm-5.3-prime "$(cat docs/swarm/PROMPT-zan-b2.md)" 2>&1 | tee docs/swarm/zan-b2.log
echo "=== ЗАН-РЕВЬЮ B2 ЗАВЕРШЕНО, код $? ==="
read -r -p "Enter — закрыть вкладку"
