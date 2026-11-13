#!/usr/bin/env bash
# Публикация обновления Aura IDE: сборка → заливка установщика → latest.json.
#
# ВНИМАНИЕ: перед публикацией убедитесь, что сборка ЗАПУСКАЕТСЯ:
#   bin/ide.cmd --version   и запуск GUI из установки.
# В этой ветке форка сборка с win32VersionedUpdate:true падает на старте
# (icu_util.cc, см. docs/desktop-app.md) — публиковать её нельзя.
# После этого установленные копии сами увидят обновление (проверка при старте
# и раз в час) и поставят его в фоне — exe по чатам больше не рассылаем.
#
# ВАЖНО: commit hash в product.json — идентификатор версии. Клиент сравнивает его
# с version из latest.json: совпали — обновления не предлагают. Поэтому порядок
# такой: всю работу коммитим и пушим, и только потом собираем установщик. Если
# собрать до коммита, в сборку попадёт старый HEAD и обновление не увидит никто.
#
# Запуск: bash scripts/publish-ide-update.sh          (сборка + заливка)
#         bash scripts/publish-ide-update.sh --upload (только залить уже собранный)
#         bash scripts/publish-ide-update.sh --refresh (пересобрать только установщик)
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
	echo "== [1/5] Проверка дерева =="
	if [[ -n "$(git status --porcelain)" ]]; then
		echo "!! В рабочем дереве есть незакоммиченные изменения."
		echo "   Commit — идентификатор версии: пользователи не увидят обновление,"
		echo "   а код, который у них окажется, разойдётся с GitHub. Сначала commit + push."
		exit 1
	fi

	if [[ "${1:-}" == "--refresh" ]]; then
		echo "== [2/5] Только установщик из уже собранного приложения =="
	else
		echo "== [2/5] Сборка приложения (≈10–15 мин)…"
		npm run gulp vscode-win32-x64
	fi
	echo "== [3/5] inno_updater и установщик (user-install) =="
	npm run gulp vscode-win32-x64-inno-updater
	npm run gulp vscode-win32-x64-user-setup
fi

echo "== [4/5] Метаданные релиза =="
if [[ ! -f "$SETUP" ]]; then
	echo "!! Нет установщика: $SETUP"
	echo "   Соберите его: npm run gulp vscode-win32-x64-user-setup"
	exit 1
fi
# Единый вердикт по собранному приложению и установщику (раскладка с папкой
# коммита, совпадение версии с HEAD, user-install, sha/size).
node scripts/check-ide-release.mjs || exit 1
PRODUCT=$(cygpath -w "$(find "$BUILD_DIR" -maxdepth 4 -path '*/resources/app/product.json' | head -1)" 2>/dev/null || find "$BUILD_DIR" -maxdepth 4 -path '*/resources/app/product.json' | head -1)
COMMIT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).commit)" "$PRODUCT")
VERSION=$(node -e "console.log(require('./package.json').version)")
SHA=$(sha256 "$SETUP")
SIZE=$(node -e "console.log(require('fs').statSync(process.argv[1]).size)" "$SETUP")
AGE=$(( ($(date +%s) - $(stat -c %Y "$SETUP" 2>/dev/null || echo 0)) / 60 ))
echo "    commit=$COMMIT"
echo "    version=$VERSION"
echo "    sha256=$SHA"
echo "    size=$SIZE, собран ${AGE} мин назад"

echo "== [5/5] Заливка на сервер =="
if ! $SSH -o BatchMode=no -o NumberOfPasswordPrompts=1 "$HOST" true 2>/dev/null; then
	echo "!! Нет SSH-доступа к $HOST (нужен ключ или пароль). Заливка не выполнена."
	exit 1
fi
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
