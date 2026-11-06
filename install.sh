#!/usr/bin/env bash
# Instala shop.civired.com en este servidor (hosting06) con un solo comando:
#   curl -fsSL https://raw.githubusercontent.com/senvisito/civired-shop/main/install.sh | sudo bash
# Es seguro repetirlo: no borra nada, solo completa lo que falte.
set -euo pipefail
# Todo va dentro de main(): así bash lee el script entero antes de ejecutar y
# ningún comando (docker compose exec/run) se "come" el resto al instalar con curl | bash.
main() {
DIR=/opt/civired-shop
REPO=https://github.com/senvisito/civired-shop
DOMAIN=${SHOP_DOMAIN:-shop.civired.com}
ADMIN_EMAIL=${ADMIN_EMAIL:-soporte@civired.com}
[ "$(id -u)" = 0 ] || { echo "Ejecútalo con sudo"; exit 1; }

ask() { # ask VAR "pregunta" [secreto]
  local v
  if [ "${3:-}" = secret ]; then read -r -s -p "$2: " v </dev/tty; echo >&2; else read -r -p "$2: " v </dev/tty; fi
  printf '%s' "$v"
}
setenv() { # setenv CLAVE valor  (escribe en .env sin mostrarlo)
  local k=$1 v=$2
  if grep -q "^$k=" .env; then
    python3 - "$k" "$v" <<'PY'
import sys
k, v = sys.argv[1], sys.argv[2]
lines = open('.env').read().splitlines()
open('.env', 'w').write('\n'.join(f'{k}={v}' if l.startswith(k + '=') else l for l in lines) + '\n')
PY
  else echo "$k=$v" >> .env; fi
}
getenv() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }

install_docker() {
  echo "== Instalando Docker"
  if curl -fsSL https://get.docker.com | sh; then return 0; fi
  # Si download.docker.com no es accesible desde el servidor, se usa el Docker de los repositorios de Debian
  echo "== download.docker.com no responde: instalo Docker desde los repositorios de Debian"
  rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io
  systemctl enable --now docker
}
install_plugins() {
  # docker compose y docker buildx (plugins): primero de Debian, si no, el binario oficial de GitHub
  local P=/usr/local/lib/docker/cli-plugins A B
  mkdir -p $P
  case "$(uname -m)" in x86_64) A=x86_64; B=amd64;; aarch64) A=aarch64; B=arm64;; *) A=$(uname -m); B=$A;; esac
  if ! docker compose version >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 || \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 || true
    docker compose version >/dev/null 2>&1 || { curl -fsSL -o $P/docker-compose "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-$A" && chmod +x $P/docker-compose; }
  fi
  if ! docker buildx version >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-buildx-plugin >/dev/null 2>&1 || \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-buildx >/dev/null 2>&1 || true
    docker buildx version >/dev/null 2>&1 || { curl -fsSL -o $P/docker-buildx "https://github.com/docker/buildx/releases/download/v0.20.1/buildx-v0.20.1.linux-$B" && chmod +x $P/docker-buildx; }
  fi
  docker compose version && docker buildx version
}
command -v docker >/dev/null || install_docker
systemctl is-active --quiet docker || systemctl start docker
install_plugins
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git)
command -v python3 >/dev/null || (apt-get update -qq && apt-get install -y -qq python3)

if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q; else git clone -q "$REPO" "$DIR"; fi
cd "$DIR"

if [ ! -f .env ]; then
  cp .env.example .env; chmod 600 .env
  setenv DB_PASSWORD "$(openssl rand -hex 24)"
  setenv DB_ROOT_PASSWORD "$(openssl rand -hex 24)"
  setenv SHOP_DOMAIN "$DOMAIN"
  echo; echo "== Datos de la API de Ingram Micro (developer.ingrammicro.com > My Apps > tu app de producción)"
  echo "   Se guardan solo en $DIR/.env en este servidor (no se suben a ningún sitio)."
  setenv IM_CLIENT_ID "$(ask x 'Client ID (Consumer Key)')"
  setenv IM_CLIENT_SECRET "$(ask x 'Client Secret (no se verá al escribir)' secret)"
  setenv IM_CUSTOMER_NUMBER "$(ask x 'Número de cliente Ingram (ej. 20-123456)')"
fi

PORT=$(getenv SHOP_PORT)
if ss -ltn | grep -qE "[:.]$PORT\s" && [ -z "$(docker compose ps -q wordpress 2>/dev/null)" ]; then
  echo "El puerto $(getenv SHOP_PORT) ya está en uso por otro programa. Cambia SHOP_PORT en $DIR/.env y avisa a Claude."; exit 1
fi

echo "== Arrancando base de datos y WordPress"
docker compose up -d db wordpress
for i in $(seq 1 60); do docker compose exec -T wordpress test -f wp-config.php 2>/dev/null && break; sleep 3; done

ADMIN_USER=civired-admin
SYNC_USER=civired-sync
CRED=/root/civired-shop-admin.txt
if [ ! -f "$CRED" ]; then
  ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
  printf 'Panel: https://%s/wp-admin\nUsuario: %s\nContraseña: %s\n' "$DOMAIN" "$ADMIN_USER" "$ADMIN_PASS" > "$CRED"; chmod 600 "$CRED"
  NEW_ADMIN=1
else ADMIN_PASS=$(grep '^Contraseña: ' "$CRED" | cut -d' ' -f2); NEW_ADMIN=0; fi

echo "== Instalando y configurando WooCommerce (tarda 1-2 minutos)"
docker compose --profile tools run --rm -T \
  -e SITE_URL="https://$DOMAIN" -e ADMIN_USER="$ADMIN_USER" -e ADMIN_PASS="$ADMIN_PASS" \
  -e ADMIN_EMAIL="$ADMIN_EMAIL" -e SYNC_USER="$SYNC_USER" \
  wpcli sh /scripts/setup-wp.sh

if [ -z "$(getenv WP_APP_PASSWORD)" ]; then
  APP=$(docker compose --profile tools run --rm -T wpcli wp user application-password create "$SYNC_USER" sync --porcelain | tr -d '\r\n ')
  setenv WP_USER "$SYNC_USER"; setenv WP_APP_PASSWORD "$APP"
fi

echo "== Arrancando la sincronización con proveedores"
docker compose up -d --build sync

# Copia diaria de la base de datos (14 días)
cat > /etc/cron.daily/civired-shop-backup <<CRON
#!/bin/sh
cd $DIR && mkdir -p backups && docker compose exec -T db sh -c 'mariadb-dump -uroot -p"\$MARIADB_ROOT_PASSWORD" shop' | gzip > backups/shop-\$(date +%F).sql.gz
find $DIR/backups -name '*.sql.gz' -mtime +14 -delete
CRON
chmod +x /etc/cron.daily/civired-shop-backup

# Actualización automática desde GitHub cada 5 minutos (reintenta si falla)
cat > /usr/local/bin/civired-shop-autoupdate <<'UPD'
#!/bin/sh
cd /opt/civired-shop || exit 0
LOG=/var/log/civired-shop-update.log
git fetch -q origin main || exit 0
TARGET=$(git rev-parse origin/main)
[ "$TARGET" = "$(cat .deployed 2>/dev/null)" ] && exit 0
git reset -q --hard origin/main
if docker compose build sync >> $LOG 2>&1 && docker compose up -d >> $LOG 2>&1; then
  echo "$TARGET" > .deployed; echo "$(date -Is) OK actualizado a $(git rev-parse --short HEAD)" >> $LOG
else
  echo "$(date -Is) ERROR al construir $(git rev-parse --short HEAD); se reintentará" >> $LOG
fi
UPD
chmod +x /usr/local/bin/civired-shop-autoupdate
echo '*/5 * * * * root /usr/local/bin/civired-shop-autoupdate' > /etc/cron.d/civired-shop-autoupdate
git rev-parse HEAD > .deployed

echo; echo "== Comprobando conexiones"
docker compose run --rm -T sync node src/index.js check || echo "(Hay algo que revisar: pásale este resultado a Claude)"
echo; echo "== Estado"; docker compose ps --format 'table {{.Service}}\t{{.State}}'
echo; echo "== Prueba local"; curl -s -o /dev/null -w "WordPress HTTP %{http_code}\n" -H "X-Forwarded-Proto: https" -H "Host: $DOMAIN" http://127.0.0.1:$(getenv SHOP_PORT)/ || true
echo
if [ "$NEW_ADMIN" = 1 ]; then
  echo "== ACCESO AL PANEL (guárdalo; también queda en $CRED)"; cat "$CRED"
else echo "Acceso al panel guardado en $CRED"; fi
echo "La primera sincronización ya está en marcha. Ver progreso: cd $DIR && docker compose logs -f sync"
}
main "$@" </dev/null
