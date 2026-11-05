#!/usr/bin/env bash
# Публикация обновления Aura IDE: сборка → заливка установщика → latest.json.
# После этого установленные копии сами увидят обновление (проверка при старте
# и раз в час) и поставят его в фоне — exe по чатам больше не рассылаем.
#
# ВАЖНО: перед запуском ЗАКОММИТЬТЕ изменения и запушьте в GitHub — commit hash
# из product.json является идентификатором версии. Без нового коммита клиенты
# увидят ту же версию, что у них уже стоит, и обновление не предложат.
#
# Запуск: bash scripts/publish-ide-update.sh          (полный цикл)
#         bash scripts/publish-ide-update.sh --upload (только залить уже собранный)
set -euo pipefail

HOST="root@94.141.160.70"
REMOTE_DIR="/opt/ide-updates"
PUBLIC_URL="https://auraide.xyz/updates"
SSH_OPTS="-o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new"
# Ключ, если он уже установлен; иначе ssh/scp спросят пароль.
if [[ -f "$HOME/.ssh/id_ed25519" ]]; then SSH_OPTS="$SSH_OPTS -i $HOME/.ssh/id_ed25519"; fi
SSH="ssh $SSH_OPTS"
SCP="scp $SSH_OPTS"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BUILD_DIR="$(dirname "$ROOT")/VSCode-win32-x64"
SETUP=".build/win32-x64/user-setup/IDESetup.exe"

sha256() {
	if command -v certutil >/dev/null 2>&1; then
		certutil -hashfile "$1" SHA256 | sed -n 2p | tr -d ' \r'
	else
		sha256sum "$1" | cut -d' ' -f1
	fi
}

if [[ "${1:-}" != "--upload" ]]; then
	echo "== [1/4] Проверка дерева =="
	if [[ -n "$(git status --porcelain)" ]]; then
		echo "!! В рабочем дереве есть незакоммиченные изменения."
		echo "   Commit — идентификатор версии: пользователи не увидят обновление,"
		echo "   а product.json в сборке разойдётся с GitHub. Сначала commit + push."
		exit 1
	fi

	echo "== [2/4] Сборка приложения и установщика (≈30 мин)…"
	npm run gulp vscode-win32-x64
	npm run gulp vscode-win32-x64-inno-updater
	npm run gulp vscode-win32-x64-user-setup
fi

echo "== [3/4] Метаданные релиза =="
if [[ ! -f "$SETUP" ]]; then
	echo "!! Нет установщика: $SETUP"
	echo "   Соберите его: npm run gulp vscode-win32-x64-user-setup"
	exit 1
fi
COMMIT=$(node -e "console.log(require('$BUILD_DIR/resources/app/product.json').commit)")
VERSION=$(node -e "console.log(require('./package.json').version)")
SHA=$(sha256 "$SETUP")
AGE=$(( ($(date +%s) - $(stat -c %Y "$SETUP" 2>/dev/null || echo 0)) / 60 ))
echo "    commit=$COMMIT"
echo "    version=$VERSION"
echo "    sha256=$SHA"
echo "    установщик собран ${AGE} мин назад (должен быть свежее коммита)"

echo "== [4/4] Заливка на сервер =="
$SSH "$HOST" "mkdir -p $REMOTE_DIR/public && chmod 755 $REMOTE_DIR $REMOTE_DIR/public"
$SCP "$SETUP" "$HOST:$REMOTE_DIR/public/IDESetup.exe.tmp"
$SSH "$HOST" "mv $REMOTE_DIR/public/IDESetup.exe.tmp $REMOTE_DIR/public/IDESetup.exe && chmod 644 $REMOTE_DIR/public/IDESetup.exe"

# latest.json пишется атомарно (tmp + mv): клиент никогда не прочитает половину.
$SSH "$HOST" "cat > $REMOTE_DIR/latest.json.tmp <<'EOF'
{
  \"version\": \"$COMMIT\",
  \"productVersion\": \"$VERSION\",
  \"url\": \"$PUBLIC_URL/IDESetup.exe\",
  \"sha256hash\": \"$SHA\",
  \"timestamp\": $(date +%s000)
}
EOF
mv $REMOTE_DIR/latest.json.tmp $REMOTE_DIR/latest.json && chmod 644 $REMOTE_DIR/latest.json"

echo
echo "== Проверка фида =="
curl -sS -o /dev/null -w "  чужой коммит → HTTP %{http_code} (ждём 200)\n" \
	"https://auraide.xyz/api/update/win32-x64-user/ide/0000000000000000000000000000000000000000" || true
curl -sS -o /dev/null -w "  текущий коммит → HTTP %{http_code} (ждём 204)\n" \
	"https://auraide.xyz/api/update/win32-x64-user/ide/$COMMIT" || true

echo
echo "== Опубликовано: $VERSION / $COMMIT"
echo "   Клиенты подтянут обновление при старте или в течение часа."
