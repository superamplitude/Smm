#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${SMM_REPO_URL:-https://github.com/superamplitude/Smm}"
RUNNER_TOKEN="${SMM_RUNNER_TOKEN:-${1:-}}"
RUNNER_NAME="${SMM_RUNNER_NAME:-smm-production}"
RUNNER_USER="${SMM_RUNNER_USER:-smmrunner}"
RUNNER_DIR="${SMM_RUNNER_DIR:-/opt/actions-runner-smm}"
LABELS="${SMM_RUNNER_LABELS:-smm,production}"

log(){ printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail(){ echo "ERRO: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "execute como root"

if [[ -z "$RUNNER_TOKEN" ]]; then
  printf 'Cole agora o token do runner GitHub para superamplitude/Smm: '
  IFS= read -r -s RUNNER_TOKEN
  printf '\n'
fi
[[ -n "$RUNNER_TOKEN" ]] || fail "token não informado"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl jq tar gzip ca-certificates sudo

id "$RUNNER_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$RUNNER_USER"
mkdir -p "$RUNNER_DIR"
chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) RUNNER_ARCH="x64" ;;
  aarch64|arm64) RUNNER_ARCH="arm64" ;;
  *) fail "arquitetura não suportada: $ARCH" ;;
esac

log "Descobrindo versão atual do GitHub Actions Runner"
TAG="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name)"
VERSION="${TAG#v}"
PKG="actions-runner-linux-${RUNNER_ARCH}-${VERSION}.tar.gz"
URL="https://github.com/actions/runner/releases/download/${TAG}/${PKG}"

log "Instalando runner ${VERSION} em ${RUNNER_DIR}"
rm -rf "${RUNNER_DIR:?}"/*
curl -fL "$URL" -o "/tmp/$PKG"
tar xzf "/tmp/$PKG" -C "$RUNNER_DIR"
rm -f "/tmp/$PKG"
chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"

log "Configurando runner para $REPO_URL"
cd "$RUNNER_DIR"
sudo -u "$RUNNER_USER" ./config.sh \
  --url "$REPO_URL" \
  --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$LABELS" \
  --work "_work" \
  --unattended \
  --replace

unset RUNNER_TOKEN

log "Instalando serviço do runner"
./svc.sh install "$RUNNER_USER" || true
./svc.sh start
./svc.sh status

log "Runner configurado"
echo "RUNNER_NAME=$RUNNER_NAME"
echo "RUNNER_DIR=$RUNNER_DIR"
echo "REPO_URL=$REPO_URL"
echo "STATUS=READY"
