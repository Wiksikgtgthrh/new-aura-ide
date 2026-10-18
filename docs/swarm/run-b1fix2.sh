#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd "/c/new-aura-ide/vscode-main"
opencode run -m dashscope/kimi-k3 "$(cat docs/swarm/PROMPT-b1fix2.md)" 2>&1 | tee docs/swarm/b1fix2.log
echo "=== b1fix2 ЗАВЕРШЁН ==="
read -r -p "Enter — закрыть вкладку"
