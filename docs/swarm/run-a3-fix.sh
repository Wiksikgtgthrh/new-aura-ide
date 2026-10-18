#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd /c/new-aura-ide/vscode-main
opencode run -m dashscope/kimi-k3 "$(cat docs/swarm/PROMPT-a3-fix.md)" 2>&1 | tee docs/swarm/a3-fix.log
echo "=== A3-FIX ЗАВЕРШЁН ==="
read -r -p "Enter — закрыть вкладку"
