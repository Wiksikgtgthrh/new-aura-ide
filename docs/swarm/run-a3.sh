#!/usr/bin/env bash
. ~/.secrets/dashscope.env
cd /c/new-aura-ide/vscode-main
opencode run -m dashscope/deepseek-v4-pro "$(cat docs/swarm/PROMPT-a3-i18n-mem.md)" 2>&1 | tee docs/swarm/a3.log
echo "=== A3 ЗАВЕРШЁН ==="
read -r -p "Enter — закрыть вкладку"
