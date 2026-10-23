#!/usr/bin/env bash
# SKYHOST installer. Safe to run again: it never overwrites an existing secret in .env.
#
#   ./scripts/install.sh --domain app.example.com --apps-domain apps.example.com --email admin@example.com
#
# Options:
#   --domain HOST          dashboard host (https://HOST)
#   --apps-domain HOST     wildcard base domain for applications (*.HOST must point to this server)
#   --email EMAIL          Let's Encrypt account email
#   --http                 no TLS (local or private network installs only)
#   --allow-runc           run customer containers with runc when gVisor is missing (weaker isolation)
#   --install-gvisor       install gVisor (runsc) and register it with Docker (Debian/Ubuntu, needs root)
#   --observability        also start Prometheus, Loki, Promtail and Grafana
#   --no-start             only prepare .env (no image build, nothing started)
#   --pull                 pull published images instead of building them locally
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ENV_FILE="$ROOT/.env"

DOMAIN="" APPS_DOMAIN="" EMAIL="" HTTP=0 ALLOW_RUNC=0 INSTALL_GVISOR=0 OBS=0 START=1 PULL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --apps-domain) APPS_DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --http) HTTP=1; shift ;;
    --allow-runc) ALLOW_RUNC=1; shift ;;
    --install-gvisor) INSTALL_GVISOR=1; shift ;;
    --observability) OBS=1; shift ;;
    --no-start) START=0; shift ;;
    --pull) PULL=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------------------------------ prerequisites
command -v docker >/dev/null || die "Docker is required: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon (are you in the docker group?)"
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is required (docker compose)"
docker buildx version >/dev/null 2>&1 || die "Docker Buildx is required for BuildKit builds"
command -v openssl >/dev/null || die "openssl is required to generate secrets"

# ------------------------------------------------------------------------------------------ .env
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "Created .env from .env.example"
else
  info "Keeping the existing .env (only empty values are filled)"
fi

get_env() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -qE "^$key=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
  else
    cp "$ENV_FILE" "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}
fill_if_empty() { [ -n "$(get_env "$1")" ] || { set_env "$1" "$2"; info "Generated $1"; }; }
rand() { openssl rand -hex "${1:-32}"; }

fill_if_empty SKYHOST_MASTER_KEYS "k1:$(openssl rand -base64 32 | tr -d '\n')"
fill_if_empty SKYHOST_INTERNAL_TOKEN "$(rand 32)"
fill_if_empty SKYHOST_SESSION_SECRET "$(rand 32)"
fill_if_empty POSTGRES_PASSWORD "$(rand 24)"
fill_if_empty REDIS_PASSWORD "$(rand 24)"
fill_if_empty GRAFANA_ADMIN_PASSWORD "$(rand 16)"

# Domains: flags win; otherwise keep what .env already has; prompt when interactive and still a placeholder.
prompt_value() {
  local key="$1" question="$2" current
  current="$(get_env "$key")"
  if [[ -z "$current" || "$current" == *example.com* ]] && [ -t 0 ]; then
    read -r -p "$question: " answer
    [ -n "$answer" ] && set_env "$key" "$answer"
  fi
}
if [ -n "$DOMAIN" ]; then
  scheme=https; [ "$HTTP" = 1 ] && scheme=http
  set_env SKYHOST_DASHBOARD_URL "$scheme://$DOMAIN"
  set_env SKYHOST_API_URL "$scheme://$DOMAIN"
fi
[ -n "$APPS_DOMAIN" ] && set_env SKYHOST_BASE_DOMAIN "$APPS_DOMAIN" && set_env SKYHOST_DATABASE_PUBLIC_HOST "db.$APPS_DOMAIN"
[ -n "$EMAIL" ] && set_env ACME_EMAIL "$EMAIL"
[ -n "$EMAIL" ] && [ -z "$(get_env SKYHOST_SUPPORT_EMAIL)" ] && set_env SKYHOST_SUPPORT_EMAIL "$EMAIL"
if [ -z "$DOMAIN" ]; then
  prompt_value SKYHOST_DASHBOARD_URL "Dashboard URL (e.g. https://app.mycompany.com)"
  set_env SKYHOST_API_URL "$(get_env SKYHOST_DASHBOARD_URL)"
fi
[ -z "$APPS_DOMAIN" ] && prompt_value SKYHOST_BASE_DOMAIN "Wildcard domain for applications (e.g. apps.mycompany.com)"
[ -z "$EMAIL" ] && [ "$HTTP" = 0 ] && prompt_value ACME_EMAIL "Email for Let's Encrypt"
if [ "$HTTP" = 1 ]; then
  set_env SKYHOST_TLS false
  set_env SKYHOST_PUBLIC_SCHEME http
fi

dash="$(get_env SKYHOST_DASHBOARD_URL)"
if [[ "$dash" == *example.com* ]]; then
  warn "SKYHOST_DASHBOARD_URL is still a placeholder ($dash). Edit .env or pass --domain."
fi

# ------------------------------------------------------------------------------------------ isolation
has_runsc() { docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"'; }
if [ "$INSTALL_GVISOR" = 1 ] && ! has_runsc; then
  [ "$(id -u)" = 0 ] || die "--install-gvisor needs root"
  command -v apt-get >/dev/null || die "--install-gvisor supports Debian/Ubuntu only; see https://gvisor.dev/docs/user_guide/install/"
  info "Installing gVisor"
  apt-get update -qq && apt-get install -y -qq curl gnupg ca-certificates
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
  apt-get update -qq && apt-get install -y -qq runsc
  runsc install
  systemctl restart docker
fi
if has_runsc; then
  info "gVisor (runsc) is available: customer containers run sandboxed"
  set_env SKYHOST_CONTAINER_RUNTIME runsc
  set_env SKYHOST_BUILD_RUNTIME runsc
elif [ "$ALLOW_RUNC" = 1 ]; then
  warn "gVisor is not installed: customer containers will use runc (weaker isolation). Do not run untrusted code like this."
  set_env SKYHOST_CONTAINER_RUNTIME runc
  set_env SKYHOST_BUILD_RUNTIME runc
elif [ "$(get_env SKYHOST_CONTAINER_RUNTIME)" = runsc ]; then
  die "gVisor (runsc) is not registered with Docker. Re-run with --install-gvisor, or --allow-runc for a development install."
fi

# Files the observability stack reads (Prometheus cannot expand environment variables).
mkdir -p "$ROOT/.data"
chmod 700 "$ROOT/.data"
umask 077
printf '%s' "$(get_env SKYHOST_INTERNAL_TOKEN)" > "$ROOT/.data/prometheus-token"
umask 022

# ------------------------------------------------------------------------------------------ images & start
profiles=()
[ "$OBS" = 1 ] && profiles+=(--profile observability)
if [ "$START" = 0 ]; then
  info ".env is ready. Start later with: ./scripts/install.sh"
  exit 0
fi
if [ "$PULL" = 1 ]; then
  info "Pulling images"
  docker compose "${profiles[@]}" pull
else
  info "Building SKYHOST images (first build takes a few minutes)"
  docker compose "${profiles[@]}" build
fi

info "Starting SKYHOST"
docker compose "${profiles[@]}" up -d
info "Waiting for the API to become healthy"
for _ in $(seq 1 90); do
  state="$(docker inspect -f '{{.State.Health.Status}}' skyhost-api 2>/dev/null || echo starting)"
  [ "$state" = healthy ] && break
  sleep 2
done
[ "$state" = healthy ] || die "The API did not become healthy. Check: ./skyhost logs api"
info "SKYHOST is running at $(get_env SKYHOST_DASHBOARD_URL)"
echo "    The first account you create becomes the platform administrator."
echo "    DNS: point $(get_env SKYHOST_DASHBOARD_URL | sed -E 's#https?://##') and *.$(get_env SKYHOST_BASE_DOMAIN) to this server."
