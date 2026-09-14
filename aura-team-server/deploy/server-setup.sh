#!/usr/bin/env bash
# Aura Team Server — автодеплой на VPS (Ubuntu 20.04+, под root или sudo).
# Выполнить: sudo bash server-setup.sh
set -euo pipefail

SERVER_IP="${AURA_IP:-2.26.98.160}"
AURA_PORT="${AURA_PORT:-3210}"
REPO="https://github.com/Wiksikgtgthrh/new-aura-ide.git"
APP_DIR="/opt/aura-team-server"
DATA_DIR="/var/lib/aura-team"

log() { echo -e "\n\033[1;32m==>\033[0m $*"; }

if [[ $EUID -ne 0 ]]; then log "Запустите скрипт от root: sudo bash $0"; exit 1; fi

log "1/7 Установка зависимостей (curl, git, ufw, Node 22)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates ufw >/dev/null
if ! command -v node >/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 22 ]]; then
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
	apt-get install -y -qq nodejs >/dev/null
fi
log "Node: $(node -v) · npm: $(npm -v)"

log "2/7 Копирование кода сервера (sparse-клон, без остального форка)"
rm -rf "$APP_DIR"
git clone --depth 1 --filter=blob:none --sparse "$REPO" "$APP_DIR" >/dev/null 2>&1
cd "$APP_DIR"
git sparse-checkout set aura-team-server >/dev/null
cd "$APP_DIR/aura-team-server"

log "3/7 Генерация секретов и .env"
mkdir -p "$DATA_DIR" /etc/aura-team
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(40).toString('base64url'))")
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
cat > /etc/aura-team.env <<ENV
AURA_HOST=0.0.0.0
AURA_PORT=$AURA_PORT
AURA_PUBLIC_URL=http://$SERVER_IP:$AURA_PORT
AURA_DATA_DIR=$DATA_DIR
AURA_JWT_SECRET=$JWT_SECRET
AURA_MASTER_KEY=$MASTER_KEY
NODE_ENV=development
ENV
chmod 600 /etc/aura-team.env
log "Секреты записаны в /etc/aura-team.env (chmod 600)"

log "4/7 npm install && build"
npm install --no-audit --no-fund --omit=optional >/dev/null 2>&1
npm run build

log "5/7 systemd-сервис aura-team"
cat > /etc/systemd/system/aura-team.service <<UNIT
[Unit]
Description=Aura Team Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR/aura-team-server
EnvironmentFile=/etc/aura-team.env
ExecStart=/usr/bin/node $APP_DIR/aura-team-server/dist/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable aura-team >/dev/null 2>&1 || true
systemctl restart aura-team
sleep 2

log "6/7 Открытие порта $AURA_PORT в файрволе"
ufw allow "$AURA_PORT"/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
ufw status | grep -q "$AURA_PORT" && log "ufw: порт $AURA_PORT открыт" || log "ВНИМАНИЕ: не смог открыть порт в ufw — откройте его в панели PLAY2GO/внешнем фаерволе."

log "7/7 Проверка"
sleep 1
LOCAL=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$AURA_PORT/v1/me" || echo ERR)
echo "локальный /v1/me -> $LOCAL (ожидается 401/403 — это нормально, нужен токен)"
echo "внешний  http://$SERVER_IP:$AURA_PORT/v1/me -> $(curl -sS -m 8 -o /dev/null -w '%{http_code}' "http://$SERVER_IP:$AURA_PORT/v1/me" 2>&1 || echo '<недоступен: порт закрыт файрволом хостера>')"
log "Готово. Регистрация: http://$SERVER_IP:$AURA_PORT/register"
log "Лог сервера: journalctl -u aura-team -f   (там же ссылка верификации без SMTP)"
