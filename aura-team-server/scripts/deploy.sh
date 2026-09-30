#!/usr/bin/env bash
# --------------------------------------------------------------------------------------
# Aura Team Server — деплой на VPS одной командой.
#
#   ./scripts/deploy.sh                  # на сервер по умолчанию (root@94.141.160.70)
#   ./scripts/deploy.sh user@host        # свой адрес
#   AURA_SSH="root@94.141.160.70" AURA_SSH_PORT=22 ./scripts/deploy.sh
#
# Что делает: rsync исходников → npm ci на сервере → build → рестарт systemd-сервиса
# → проверка /health. База данных (data/, .env) не трогается.
# --------------------------------------------------------------------------------------
set -euo pipefail

# --- Настройки (можно переопределить переменными окружения) ---
REMOTE="${1:-${AURA_SSH:-root@94.141.160.70}}"
SSH_PORT="${AURA_SSH_PORT:-22}"
APP_DIR="${AURA_APP_DIR:-/opt/aura-team-server/aura-team-server}"
SERVICE="${AURA_SERVICE:-aura-team}"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # корень aura-team-server

log() { echo -e "\033[1;32m==>\033[0m $*"; }
fail() { echo -e "\033[1;31mОШИБКА:\033[0m $*" >&2; exit 1; }

command -v rsync >/dev/null || fail "rsync не найден локально (git bash: установите через пакетный менеджер)."

log "Деплой $LOCAL_DIR → $REMOTE:$APP_DIR"

# 1. Синхронизация кода (без node_modules, data и секретов — на сервере свои).
log "1/4 rsync исходников"
rsync -az --delete \
	--exclude 'node_modules/' \
	--exclude 'dist/' \
	--exclude 'data/' \
	--exclude '.env' \
	--exclude '.git/' \
	-e "ssh -p $SSH_PORT" \
	"$LOCAL_DIR/" "$REMOTE:$APP_DIR/"

# 2. Зависимости + сборка прямо на сервере (better-sqlite3 — нативный модуль,
# собирать надо под ту же ОС/архитектуру, что и runtime; локальный dist не переносим).
log "2/4 npm ci + build на сервере"
ssh -p "$SSH_PORT" "$REMOTE" "cd '$APP_DIR' && npm ci --no-audit --no-fund && npm run build"

# 3. Рестарт сервиса. Если деплой делаем не от root — попробуем через sudo.
log "3/4 рестарт $SERVICE"
ssh -p "$SSH_PORT" "$REMOTE" "
	if systemctl is-active --quiet '$SERVICE'; then
		systemctl restart '$SERVICE' && echo 'сервис перезапущен'
	elif sudo -n systemctl restart '$SERVICE' 2>/dev/null; then
		echo 'сервис перезапущен (через sudo)'
	else
		echo 'ПРЕДУПРЕЖДЕНИЕ: не удалось перезапустить сервис автоматически.' >&2
		echo 'Выполните вручную: ssh -p $SSH_PORT $REMOTE sudo systemctl restart $SERVICE' >&2
	fi"

# 4. Проверка здоровья.
log "4/4 проверка /health"
sleep 2
STATUS="$(ssh -p "$SSH_PORT" "$REMOTE" "curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:\${AURA_PORT:-3210}/health 2>/dev/null || curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3210/health || echo ERR")"
if [ "$STATUS" = "200" ]; then
	log "Готово: сервер на $REMOTE отвечает /health → 200. Новый API (в т.ч. /tasks/trash) активен."
else
	fail "Сервер не отвечает /health → $STATUS. Логи: ssh -p $SSH_PORT $REMOTE journalctl -u $SERVICE -n 50"
fi
