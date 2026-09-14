#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${SMM_REPO_URL:-https://github.com/superamplitude/Smm}"
RUNNER_TOKEN="${SMM_RUNNER_TOKEN:-${1:-}}"
RUNNER_NAME="${SMM_RUNNER_NAME:-smm-production}"
RUNNER_USER="${SMM_RUNNER_USER:-smmrunner}"
RUNNER_DIR="${SMM_RUNNER_DIR:-/opt/actions-runner-smm}"
LABELS="${SMM_RUNNER_LABELS:-smm,production}"
RUNNER_SERVICE="github-actions-smm"
APP_SERVICE="superamplitude-smm"
APP_HEALTH="http://127.0.0.1:3008/health"

log(){ printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail(){ echo "ERRO: $*" >&2; exit 1; }

cleanup_token(){ unset RUNNER_TOKEN SMM_RUNNER_TOKEN || true; }
trap cleanup_token EXIT

[[ $EUID -eq 0 ]] || fail "execute como root"

if [[ -z "$RUNNER_TOKEN" ]]; then
  printf 'Cole o token do GitHub Runner e pressione ENTER: '
  IFS= read -r -s RUNNER_TOKEN
  printf '\n'
fi
RUNNER_TOKEN="${RUNNER_TOKEN//$'\r'/}"
RUNNER_TOKEN="${RUNNER_TOKEN//$'\n'/}"
[[ -n "$RUNNER_TOKEN" ]] || fail "token não informado"
[[ "$RUNNER_TOKEN" != *[[:space:]]* ]] || fail "token contém espaços; cole somente o token"

export DEBIAN_FRONTEND=noninteractive
log "Preparando dependências"
apt-get update -y >/dev/null
apt-get install -y curl jq tar gzip ca-certificates sudo >/dev/null

id "$RUNNER_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$RUNNER_USER"
if getent group smmdeploy >/dev/null 2>&1; then
  usermod -aG smmdeploy "$RUNNER_USER"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) RUNNER_ARCH="x64" ;;
  aarch64|arm64) RUNNER_ARCH="arm64" ;;
  *) fail "arquitetura não suportada: $ARCH" ;;
esac

log "Parando instalação anterior, se existir"
systemctl stop "$RUNNER_SERVICE" 2>/dev/null || true
systemctl disable "$RUNNER_SERVICE" 2>/dev/null || true
rm -f "/etc/systemd/system/${RUNNER_SERVICE}.service"
systemctl daemon-reload
rm -rf "$RUNNER_DIR"
mkdir -p "$RUNNER_DIR"
chown "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"

log "Baixando versão atual do GitHub Actions Runner"
TAG="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name)"
[[ -n "$TAG" && "$TAG" != "null" ]] || fail "não foi possível descobrir a versão do runner"
VERSION="${TAG#v}"
PKG="actions-runner-linux-${RUNNER_ARCH}-${VERSION}.tar.gz"
URL="https://github.com/actions/runner/releases/download/${TAG}/${PKG}"
curl -fL --retry 3 --retry-delay 2 "$URL" -o "/tmp/$PKG"
tar xzf "/tmp/$PKG" -C "$RUNNER_DIR"
rm -f "/tmp/$PKG"
chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"
[[ -x "$RUNNER_DIR/config.sh" ]] || fail "config.sh não foi instalado"
[[ -x "$RUNNER_DIR/run.sh" ]] || fail "run.sh não foi instalado"

log "Registrando runner no repositório"
cd "$RUNNER_DIR"
sudo -u "$RUNNER_USER" ./config.sh \
  --url "$REPO_URL" \
  --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$LABELS" \
  --work "_work" \
  --unattended \
  --replace
cleanup_token

log "Criando serviço systemd do runner"
cat >"/etc/systemd/system/${RUNNER_SERVICE}.service" <<UNIT
[Unit]
Description=GitHub Actions Runner - SMM SuperAmplitude
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUNNER_USER
WorkingDirectory=$RUNNER_DIR
ExecStart=$RUNNER_DIR/run.sh
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
UNIT

cat >"/etc/sudoers.d/${APP_SERVICE}-runner" <<SUDOERS
$RUNNER_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $APP_SERVICE
SUDOERS
chmod 440 "/etc/sudoers.d/${APP_SERVICE}-runner"
visudo -cf "/etc/sudoers.d/${APP_SERVICE}-runner" >/dev/null

systemctl daemon-reload
systemctl enable --now "$RUNNER_SERVICE"
sleep 3
systemctl is-active --quiet "$RUNNER_SERVICE" || {
  journalctl -u "$RUNNER_SERVICE" -n 80 --no-pager || true
  fail "runner não iniciou"
}

log "Validando aplicação já publicada"
APP_STATUS="$(systemctl is-active "$APP_SERVICE" 2>/dev/null || true)"
HEALTH_STATUS="FALHOU"
if curl -fsS "$APP_HEALTH" >/tmp/smm-health.json 2>/dev/null; then
  HEALTH_STATUS="OK"
fi

printf '\n============================================================\n'
printf ' SMM SUPERAMPLITUDE - INSTALAÇÃO FINALIZADA\n'
printf '============================================================\n'
printf 'RUNNER_VERSION=%s\n' "$VERSION"
printf 'RUNNER_NAME=%s\n' "$RUNNER_NAME"
printf 'RUNNER_SERVICE=%s\n' "$(systemctl is-active "$RUNNER_SERVICE")"
printf 'APP_SERVICE=%s\n' "$APP_STATUS"
printf 'APP_HEALTH=%s\n' "$HEALTH_STATUS"
if [[ -s /tmp/smm-health.json ]]; then cat /tmp/smm-health.json; echo; fi
printf 'STATUS=READY\n'
printf '============================================================\n'
