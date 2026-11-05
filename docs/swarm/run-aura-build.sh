#!/usr/bin/env bash
cd /c/new-aura-ide/vscode-main
echo "=== СБОРКА AURA IDE: npm run compile (gulp compile) ==="
echo "=== старт: $(date) ==="
npm run compile 2>&1 | tee docs/swarm/aura-build.log
echo "=== СБОРКА ЗАВЕРШЕНА, код $? · $(date) ==="
read -r -p "Enter — закрыть вкладку"
