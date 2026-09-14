#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${SMM_DEPLOY_DIR:-/home/superamplitude-smm/htdocs/smm.superamplitude.com}"
SOURCE_DIR="${GITHUB_WORKSPACE:-$(pwd)}"
SERVICE_NAME="${SMM_SERVICE_NAME:-superamplitude-smm}"
PORT="${SMM_PORT:-3008}"
RELEASE_DIR="${APP_DIR}.release"
BACKUP_ROOT="${SMM_BACKUP_DIR:-/home/superamplitude-smm/backups}"
STAMP="$(date +%Y%m%d_%H%M%S)"

log(){ printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail(){ echo "ERRO: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "execute com sudo/root"
command -v node >/dev/null || fail "Node.js não instalado"
command -v npm >/dev/null || fail "npm não instalado"
command -v rsync >/dev/null || fail "rsync não instalado"

log "Validando código"
node --check "$SOURCE_DIR/server.js"
node --check "$SOURCE_DIR/public/app.js"

mkdir -p "$(dirname "$APP_DIR")" "$BACKUP_ROOT"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

log "Montando release"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='node_modules/' \
  --exclude='.env' \
  "$SOURCE_DIR/" "$RELEASE_DIR/"

if [[ -f "$APP_DIR/.env" ]]; then
  cp -a "$APP_DIR/.env" "$RELEASE_DIR/.env"
else
  fail "Arquivo $APP_DIR/.env não existe. Execute deploy/bootstrap-vps.sh primeiro."
fi

log "Instalando dependências de produção"
cd "$RELEASE_DIR"
npm install --omit=dev --no-audit --no-fund

log "Testando conexão e inicialização básica"
node --check server.js

if [[ -d "$APP_DIR" ]]; then
  BACKUP="$BACKUP_ROOT/site_${STAMP}"
  mkdir -p "$BACKUP"
  rsync -a --exclude='node_modules/' "$APP_DIR/" "$BACKUP/"
fi

log "Publicando release"
rsync -a --delete --exclude='.env' "$RELEASE_DIR/" "$APP_DIR/"
cp -a "$RELEASE_DIR/.env" "$APP_DIR/.env"
rm -rf "$RELEASE_DIR"

chown -R smmapp:smmapp "$APP_DIR" 2>/dev/null || true

log "Reiniciando serviço"
systemctl daemon-reload
systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME" || {
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true
  fail "serviço não iniciou"
}

log "Health check"
for i in {1..20}; do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/tmp/smm-health.json; then
    cat /tmp/smm-health.json
    echo
    echo "DEPLOY_OK=1"
    echo "APP_DIR=$APP_DIR"
    echo "PORT=$PORT"
    exit 0
  fi
  sleep 1
done

journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true
fail "health check falhou"
