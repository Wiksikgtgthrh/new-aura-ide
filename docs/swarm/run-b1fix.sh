#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd "/c/new-aura-ide/vscode-main"
opencode run -m dashscope/deepseek-v4-pro "$(cat docs/swarm/PROMPT-b1fix.md)" 2>&1 | tee docs/swarm/b1fix.log
echo "=== b1fix ЗАВЕРШЁН ==="
read -r -p "Enter — закрыть вкладку"
