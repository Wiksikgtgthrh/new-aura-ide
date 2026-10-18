#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd /c/new-aura-ide/vscode-main
opencode run -m dashscope/qwen3.8-max "$(cat docs/swarm/PROMPT-b1-kotlin-emulator.md)" 2>&1 | tee docs/swarm/b1.log
echo "=== B1 ЗАВЕРШЁН, код $? ==="
read -r -p "Enter — закрыть вкладку"
