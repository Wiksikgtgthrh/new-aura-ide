#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd "/c/new-aura-ide/vscode-main"
opencode run -m dashscope/kimi-k3 "$(cat docs/swarm/PROMPT-a2-team-fix.md)" 2>&1 | tee docs/swarm/a2-team-fix.log
echo "=== a2-team-fix ЗАВЕРШЁН ==="
read -r -p "Enter — закрыть вкладку"
