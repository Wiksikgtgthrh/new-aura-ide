#!/usr/bin/env bash
# Aura Team Server — автодеплой на VPS (Ubuntu 20.04+, под root или sudo).
# Выполнить: sudo bash server-setup.sh
set -euo pipefail

SERVER_IP="${AURA_IP:-94.141.160.70}"
AURA_PORT="${AURA_PORT:-3210}"
# Публичный URL выносится в окружение: сервер слушает 127.0.0.1, наружу его отдаёт
# reverse-proxy с TLS (на живом VPS — Caddy за Xray). Дефолт ниже — только для
# локальной проверки: прод на голом HTTP раздаёт пароли и ключи открытым текстом.
AURA_PUBLIC_URL_ENV="${AURA_PUBLIC_URL:-https://auraide.xyz}"
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
AURA_HOST=127.0.0.1
AURA_PORT=$AURA_PORT
AURA_PUBLIC_URL=$AURA_PUBLIC_URL_ENV
AURA_DATA_DIR=$DATA_DIR
AURA_JWT_SECRET=$JWT_SECRET
AURA_MASTER_KEY=$MASTER_KEY
NODE_ENV=production
ENV
chmod 600 /etc/aura-team.env
log "Секреты записаны в /etc/aura-team.env (chmod 600)"

log "4/7 Отдельный сервисный пользователь и права"
id -u aura-team >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin aura-team
chown -R aura-team:aura-team "$DATA_DIR"
chown -R aura-team:aura-team "$APP_DIR"

log "4/7 npm install && build"
npm install --no-audit --no-fund >/dev/null 2>&1
npm run build
npm prune --omit=dev >/dev/null 2>&1

log "5/7 systemd-сервис aura-team"
cat > /etc/systemd/system/aura-team.service <<UNIT
[Unit]
Description=Aura Team Server
After=network.target

[Service]
Type=simple
User=aura-team
WorkingDirectory=$APP_DIR/aura-team-server
EnvironmentFile=/etc/aura-team.env
ExecStart=/usr/bin/node $APP_DIR/aura-team-server/dist/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable aura-team >/dev/null 2>&1 || true
systemctl restart aura-team
sleep 2

log "6/7 Файрвол: наружу — только SSH и веб (80/443 через reverse-proxy)"
# 3210 НЕ открываем: сервер слушает 127.0.0.1, наружу его отдаёт reverse-proxy с TLS.
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

log "7/7 Проверка"
sleep 1
LOCAL=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$AURA_PORT/v1/me" || echo ERR)
echo "локальный /v1/me -> $LOCAL (ожидается 401/403 — это нормально, нужен токен)"
if [[ "$AURA_PUBLIC_URL_ENV" == http://* && "$AURA_PUBLIC_URL_ENV" != http://127.0.0.1* ]]; then
	log "ВНИМАНИЕ: AURA_PUBLIC_URL без TLS ($AURA_PUBLIC_URL_ENV) — пароли и ключи пойдут открытым текстом. Поставьте Caddy/nginx с доменом."
fi
log "Готово. Публичный URL: $AURA_PUBLIC_URL_ENV (reverse-proxy с TLS ставится отдельно, см. deploy/Caddyfile)"
log "Лог сервера: journalctl -u aura-team -f"
