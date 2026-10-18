#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd /c/new-aura-ide/vscode-main
opencode run -m dashscope/kimi-k3 "$(cat docs/swarm/PROMPT-b1-kotlin-emulator.md)" 2>&1 | tee -a docs/swarm/b1.log
echo "=== B1 RESTART ЗАВЕРШЁН, код $? ==="
read -r -p "Enter — закрыть вкладку"
