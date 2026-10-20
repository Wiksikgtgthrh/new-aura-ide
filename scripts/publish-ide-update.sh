#!/usr/bin/env bash
# Публикация обновления IDE: сборка → заливка → latest.json на сервере.
# После этого установленные у пользователей копии сами увидят обновление
# (проверка при старте и раз в час) и поставят его в фоне.
#
# ВАЖНО: перед запуском ЗАКОММИТЬТЕ изменения — commit hash из product.json
# является идентификатором версии; без нового коммита клиенты обновление не увидят.
#
# Запуск: bash scripts/publish-ide-update.sh   (из корня vscode-main, Git Bash)
set -euo pipefail

HOST="root@94.141.160.70"
SSH="ssh -o BatchMode=yes -i $HOME/.ssh/id_ed25519"
SCP="scp -o BatchMode=yes -i $HOME/.ssh/id_ed25519"
SETUP=".build/win32-x64/user-setup/IDESetup.exe"

cd "$(dirname "$0")/.."

echo "== [1/4] Сборка приложения и установщика (≈30 мин)…"
npm run gulp vscode-win32-x64
npm run gulp vscode-win32-x64-inno-updater
npm run gulp vscode-win32-x64-user-setup

echo "== [2/4] Метаданные релиза…"
SHA=$(certutil -hashfile "$SETUP" SHA256 | sed -n 2p | tr -d ' \r')
COMMIT=$(node -e "console.log(require('./../VSCode-win32-x64/resources/app/product.json').commit)")
VERSION=$(node -e "console.log(require('./package.json').version)")
echo "    commit=$COMMIT version=$VERSION sha256=$SHA"

echo "== [3/4] Заливка установщика на сервер…"
$SCP "$SETUP" "$HOST:/opt/ide-updates/public/IDESetup.exe"

echo "== [4/4] Обновление latest.json…"
$SSH "$HOST" "cat > /opt/ide-updates/latest.json <<EOF
{
  \"version\": \"$COMMIT\",
  \"productVersion\": \"$VERSION\",
  \"sha256hash\": \"$SHA\"
}
EOF"

echo "== Опубликовано. Клиенты подтянут обновление при старте или в течение часа."
