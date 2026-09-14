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
RUNNER_USER="${SMM_RUNNER_USER:-smmrunner}"
DEPLOY_GROUP="smmdeploy"

log(){ printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail(){ echo "ERRO: $*" >&2; exit 1; }
rand(){ openssl rand -hex "$1"; }

mysql_admin_exec() {
  local sql="$1"
  if mysql -uroot -e 'SELECT 1' >/dev/null 2>&1; then
    mysql -uroot <<<"$sql"
    return 0
  fi

  if command -v clpctl >/dev/null 2>&1; then
    local master_output connect_cmd
    master_output="$(clpctl db:show:master-credentials 2>/dev/null || true)"
    connect_cmd="$(printf '%s\n' "$master_output" | sed -nE 's/.*(mysql[[:space:]].*)/\1/p' | head -n1)"
    if [[ -n "$connect_cmd" ]]; then
      eval "$connect_cmd" <<<"$sql"
      return 0
    fi
  fi

  fail "não foi possível autenticar no banco como administrador. No CloudPanel, confirme se 'clpctl db:show:master-credentials' funciona como root."
}

[[ $EUID -eq 0 ]] || fail "execute como root"

log "Instalando utilitários essenciais"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates git rsync openssl sudo

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

getent group "$DEPLOY_GROUP" >/dev/null || groupadd "$DEPLOY_GROUP"
id smmapp >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_ROOT" --shell /usr/sbin/nologin smmapp
id "$RUNNER_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$RUNNER_USER"
usermod -aG "$DEPLOY_GROUP" smmapp
usermod -aG "$DEPLOY_GROUP" "$RUNNER_USER"

cat >"/etc/sudoers.d/${SERVICE}-runner" <<SUDOERS
$RUNNER_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE
SUDOERS
chmod 440 "/etc/sudoers.d/${SERVICE}-runner"
visudo -cf "/etc/sudoers.d/${SERVICE}-runner" >/dev/null

mkdir -p "$APP_DIR" "$APP_ROOT/backups"
chown -R smmapp:"$DEPLOY_GROUP" "$APP_ROOT"
chmod -R g+rwX "$APP_ROOT"
find "$APP_ROOT" -type d -exec chmod g+s {} +

if [[ ! -f "$ENV_FILE" ]]; then
  log "Criando banco e configuração inicial"
  DB_PASS="$(rand 24)"
  JWT_SECRET="$(rand 48)"
  ADMIN_PASSWORD="Smm!$(rand 12)"

  SQL="CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;"
  mysql_admin_exec "$SQL"

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
  chmod 640 "$ENV_FILE"
  chown smmapp:"$DEPLOY_GROUP" "$ENV_FILE"
  printf '\nADMIN_INICIAL=admin@superamplitude.com\nADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD"
else
  log "Configuração existente preservada em $ENV_FILE"
  chown smmapp:"$DEPLOY_GROUP" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

log "Configurando systemd"
cat >"/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=SMM SuperAmplitude
After=network.target

[Service]
Type=simple
User=smmapp
Group=$DEPLOY_GROUP
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
echo "RUNNER_USER=$RUNNER_USER"
echo "ENV_FILE=$ENV_FILE"
echo "PRÓXIMO_PASSO=instale o runner com deploy/install-runner.sh; ele pedirá o token sem exibi-lo"
