#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${SMM_DEPLOY_DIR:-/home/superamplitude-smm/htdocs/smm.superamplitude.com}"
SOURCE_DIR="${GITHUB_WORKSPACE:-$(pwd)}"
SERVICE_NAME="${SMM_SERVICE_NAME:-superamplitude-smm}"
PORT="${SMM_PORT:-3008}"
APP_PARENT="$(dirname "$APP_DIR")"
BACKUP_ROOT="${SMM_BACKUP_DIR:-/home/superamplitude-smm/backups}"
STAMP="$(date +%Y%m%d_%H%M%S)"
RELEASE_DIR="${APP_PARENT}/.smm-release-${STAMP}-$$"
BACKUP_DIR="${BACKUP_ROOT}/site_${STAMP}"
FAILED_DIR="${BACKUP_ROOT}/failed_${STAMP}"
OLD_MOVED=0
NEW_PUBLISHED=0

umask 0002

log(){ printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

cleanup_release() {
  [[ -d "$RELEASE_DIR" ]] && rm -rf "$RELEASE_DIR" || true
}

rollback() {
  local rc="${1:-1}"
  trap - ERR INT TERM

  if [[ "$NEW_PUBLISHED" -eq 1 && "$OLD_MOVED" -eq 1 && -d "$BACKUP_DIR" ]]; then
    log "Falha detectada; executando rollback atômico"
    if [[ -e "$APP_DIR" ]]; then
      mv "$APP_DIR" "$FAILED_DIR" || true
    fi
    mv "$BACKUP_DIR" "$APP_DIR" || true
    sudo systemctl restart "$SERVICE_NAME" || true
  fi

  cleanup_release
  exit "$rc"
}

fail() {
  echo "ERRO: $*" >&2
  rollback 1
}

trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

command -v node >/dev/null || fail "Node.js não instalado"
command -v npm >/dev/null || fail "npm não instalado"
command -v rsync >/dev/null || fail "rsync não instalado"
command -v curl >/dev/null || fail "curl não instalado"
[[ -f "$APP_DIR/.env" ]] || fail "Arquivo $APP_DIR/.env não existe. Execute deploy/bootstrap-vps.sh primeiro."
[[ -w "$APP_PARENT" ]] || fail "Runner sem permissão de escrita em $APP_PARENT"
[[ -w "$BACKUP_ROOT" ]] || fail "Runner sem permissão de escrita em $BACKUP_ROOT"

log "Validando código"
node --check "$SOURCE_DIR/server.js"
node --check "$SOURCE_DIR/public/app.js"

mkdir -p "$RELEASE_DIR"

log "Montando release isolada"
rsync -rltD --delete \
  --no-perms \
  --no-owner \
  --no-group \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='node_modules/' \
  --exclude='.env' \
  "$SOURCE_DIR/" "$RELEASE_DIR/"

log "Preservando configuração de produção"
cp "$APP_DIR/.env" "$RELEASE_DIR/.env"
chmod 640 "$RELEASE_DIR/.env"

log "Instalando dependências de produção"
cd "$RELEASE_DIR"
npm install --omit=dev --no-audit --no-fund
node --check server.js
chmod -R g+rwX "$RELEASE_DIR"

log "Trocando release de forma atômica"
if [[ -d "$APP_DIR" ]]; then
  mv "$APP_DIR" "$BACKUP_DIR"
  OLD_MOVED=1
fi
mv "$RELEASE_DIR" "$APP_DIR"
NEW_PUBLISHED=1

log "Reiniciando serviço"
sudo systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME" || fail "serviço não iniciou"

log "Health check"
HEALTH_BODY=""
for i in {1..30}; do
  if HEALTH_BODY="$(curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null)"; then
    break
  fi
  HEALTH_BODY=""
  sleep 1
done

if [[ -z "$HEALTH_BODY" ]]; then
  systemctl status "$SERVICE_NAME" --no-pager -l || true
  fail "health check falhou"
fi

printf '%s\n' "$HEALTH_BODY"

trap - ERR INT TERM
cleanup_release

echo "DEPLOY_OK=1"
echo "APP_DIR=$APP_DIR"
echo "BACKUP_DIR=$BACKUP_DIR"
echo "PORT=$PORT"
echo "RELEASE_MODE=ATOMIC_SWAP"
