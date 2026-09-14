#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="${SMM_DOMAIN:-smm.superamplitude.com}"
APP_ROOT="${SMM_ROOT:-/home/superamplitude-smm}"
APP_DIR="${SMM_DEPLOY_DIR:-$APP_ROOT/htdocs/$DOMAIN}"
PORT="${SMM_PORT:-3008}"
DB_NAME="${SMM_DB_NAME:-superamplitude_smm}"
DB_USER="${SMM_DB_USER:-superamplitude_smm}"
SERVICE="${SMM_SERVICE_NAME:-superamplitude-smm}"
ENV_FILE="$APP_DIR/.env"

log(){ printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail(){ echo "ERRO: $*" >&2; exit 1; }
rand(){ openssl rand -hex "$1"; }

[[ $EUID -eq 0 ]] || fail "execute como root"

log "Instalando utilitários essenciais"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates git rsync openssl

if ! command -v node >/dev/null || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])' 2>/dev/null || echo 0)" -lt 20 ]]; then
  log "Instalando Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v mysql >/dev/null; then
  log "Instalando MariaDB"
  apt-get install -y mariadb-server
  systemctl enable --now mariadb
fi

if ! command -v nginx >/dev/null; then
  log "Instalando Nginx"
  apt-get install -y nginx
  systemctl enable --now nginx
fi

id smmapp >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_ROOT" --shell /usr/sbin/nologin smmapp
mkdir -p "$APP_DIR" "$APP_ROOT/backups"
chown -R smmapp:smmapp "$APP_ROOT"

if [[ ! -f "$ENV_FILE" ]]; then
  log "Criando banco e configuração inicial"
  DB_PASS="$(rand 24)"
  JWT_SECRET="$(rand 48)"
  ADMIN_PASSWORD="Smm!$(rand 12)"

  mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

  cat >"$ENV_FILE" <<ENV
NODE_ENV=production
PORT=$PORT
APP_URL=https://$DOMAIN
JWT_SECRET=$JWT_SECRET

DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS

AI_ENABLED=true
AI_API_BASE_URL=
AI_API_KEY=
AI_MODEL=

MERCADOPAGO_ACCESS_TOKEN=
MERCADOPAGO_WEBHOOK_SECRET=
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=
PAYPAL_MODE=live

ADMIN_EMAIL=admin@superamplitude.com
ADMIN_PASSWORD=$ADMIN_PASSWORD
ENV
  chmod 600 "$ENV_FILE"
  chown smmapp:smmapp "$ENV_FILE"
  printf '\nADMIN_INICIAL=admin@superamplitude.com\nADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD"
else
  log "Configuração existente preservada em $ENV_FILE"
fi

log "Configurando systemd"
cat >"/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=SMM SuperAmplitude
After=network.target mariadb.service

[Service]
Type=simple
User=smmapp
Group=smmapp
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$APP_ROOT

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE"

if ! grep -Rqs "server_name[[:space:]].*$DOMAIN" /etc/nginx 2>/dev/null; then
  log "Configurando proxy Nginx"
  mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  cat >"/etc/nginx/sites-available/$DOMAIN" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 90s;
    }
}
NGINX
  ln -sfn "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
  nginx -t
  systemctl reload nginx
else
  log "Vhost para $DOMAIN já existe; Nginx atual foi preservado"
fi

log "Bootstrap concluído"
echo "DOMAIN=$DOMAIN"
echo "APP_DIR=$APP_DIR"
echo "PORT=$PORT"
echo "ENV_FILE=$ENV_FILE"
echo "PRÓXIMO_PASSO=registre/inicie o GitHub runner e execute o workflow Deploy SMM SuperAmplitude"
