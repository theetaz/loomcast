#!/usr/bin/env bash
# Checks the Loomcast nginx site template with "nginx -t" in a disposable nginx:alpine container.
#
# Usage: bash infra/scripts/test-nginx.sh
#
# A self-signed placeholder certificate (and a placeholder origin-pull CA) is generated in a
# temporary directory and deleted afterwards. The Cloudflare include is written by
# cloudflare-ips.sh from documentation ranges (RFC 5737 and RFC 3849), so no network access is
# needed apart from pulling the image. A neighbour site that uses the common names
# ($connection_upgrade, the "SSL" session cache, a default_server) is loaded alongside, to prove
# the Loomcast site does not collide with other sites on a shared host.
#
# Environment: NGINX_IMAGE (default nginx:alpine).
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
image=${NGINX_IMAGE:-nginx:alpine}
domain=loomcast.prabhavalabs.com

command -v docker >/dev/null || { echo "test-nginx: docker is required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "test-nginx: openssl is required" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/loomcast-nginx-test.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

mkdir -p "$work/cert" "$work/ca" "$work/fixtures"

# Placeholder certificate for the site, valid for one day, and a placeholder client CA.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$domain" \
  -keyout "$work/cert/privkey.pem" -out "$work/cert/fullchain.pem" 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=placeholder origin pull CA" \
  -keyout "$work/ca/key.pem" -out "$work/ca/origin-pull-ca.pem" 2>/dev/null
rm -f "$work/ca/key.pem"
chmod 0644 "$work/cert/"*.pem "$work/ca/"*.pem

# Documentation ranges only. The v4 list ends without a newline, like the published one.
printf '192.0.2.0/24\n198.51.100.0/24\r\n203.0.113.0/24' >"$work/fixtures/ips-v4"
printf '2001:db8::/32\n' >"$work/fixtures/ips-v6"
printf '192.0.2.0/24\n<html>not a list</html>\n' >"$work/fixtures/ips-v4-bad"

# A neighbour site using the names other sites typically use.
cat >"$work/fixtures/neighbour.conf" <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
upstream app {
    server 127.0.0.1:3000;
}
server {
    listen 443 ssl default_server;
    server_name neighbour.example.com;
    ssl_certificate     /etc/letsencrypt/live/loomcast.prabhavalabs.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/loomcast.prabhavalabs.com/privkey.pem;
    ssl_session_cache shared:SSL:10m;
    location / {
        proxy_pass http://app;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
EOF

# Runs inside the container (busybox sh).
cat >"$work/run.sh" <<'EOF'
set -eu
fail() { echo "FAIL: $*"; exit 1; }
render=/src/scripts/render-nginx.sh
site=/etc/nginx/conf.d/loomcast.conf
export LOOMCAST_HTTP_PORT=18790

mkdir -p /etc/nginx/loomcast /var/www/loomcast-acme
cp /fixtures/neighbour.conf /etc/nginx/conf.d/neighbour.conf
cp /ca/origin-pull-ca.pem /etc/nginx/loomcast/origin-pull-ca.pem

echo "== cloudflare-ips.sh writes the include from the published-format lists"
sh /src/nginx/cloudflare-ips.sh --v4-file /fixtures/ips-v4 --v6-file /fixtures/ips-v6 \
  -o /etc/nginx/loomcast/cloudflare-ips.conf
grep -c '^set_real_ip_from ' /etc/nginx/loomcast/cloudflare-ips.conf | grep -qx 4 \
  || fail "expected 4 set_real_ip_from lines"
cat /etc/nginx/loomcast/cloudflare-ips.conf

echo "== cloudflare-ips.sh rejects a malformed list and keeps the existing include"
cp /etc/nginx/loomcast/cloudflare-ips.conf /tmp/cf-before.conf
if sh /src/nginx/cloudflare-ips.sh --v4-file /fixtures/ips-v4-bad --v6-file /fixtures/ips-v6 \
  -o /etc/nginx/loomcast/cloudflare-ips.conf 2>/tmp/cf-err; then
  fail "a malformed list was accepted"
fi
cat /tmp/cf-err
cmp -s /tmp/cf-before.conf /etc/nginx/loomcast/cloudflare-ips.conf || fail "include was modified"

echo "== render-nginx.sh rejects invalid settings"
for bad in "LOOMCAST_HTTP_PORT=abc" "LOOMCAST_HTTP_PORT=80" "LOOMCAST_DOMAIN=Bad_Host" \
  "LOOMCAST_NGINX_MODE=other" "LOOMCAST_ORIGIN_PULLS=yes" "LOOMCAST_NGINX_HTTP2=maybe"; do
  if env "$bad" sh "$render" >/dev/null 2>/tmp/render-err; then
    fail "accepted $bad"
  fi
  echo "rejected $bad: $(cat /tmp/render-err)"
done

echo "== render-nginx.sh reads the port from a compose env file"
printf 'LOOMCAST_TAG=main\nLOOMCAST_HTTP_PORT=18791\n' >/tmp/compose.env
env -u LOOMCAST_HTTP_PORT sh "$render" --compose-env /tmp/compose.env | grep -q 'server 127.0.0.1:18791;' \
  || fail "port not read from the compose env file"

check() {
  label=$1
  shift
  echo "== nginx -t: $label"
  env "$@" sh "$render" -o "$site"
  nginx -t 2>&1
}

expect() { grep -Eq "$1" "$site" || fail "expected /$1/ in the rendered site"; }
reject() { if grep -Eq "$1" "$site"; then fail "unexpected /$1/ in the rendered site"; fi; }

check "bootstrap (port 80 only, before the first certificate)" LOOMCAST_NGINX_MODE=bootstrap
expect 'location \^~ /\.well-known/acme-challenge/'
reject '^[[:space:]]*listen 443'

check "full, http2 auto (per-server http2 on this nginx)" LOOMCAST_NGINX_MODE=full
expect '^    listen 443 ssl;$'
expect '^    http2 on;$'
expect 'proxy_read_timeout 120s;'
expect 'proxy_set_header Connection \$loomcast_connection_upgrade;'
expect 'location = /api/stream'
expect 'proxy_read_timeout 3600s;'
expect 'add_header X-Accel-Buffering no always;'
expect 'client_max_body_size 2m;'
expect 'real_ip_header CF-Connecting-IP;'
expect 'server 127.0.0.1:18790;'
reject '^[[:space:]]*ssl_verify_client'
reject '^[[:space:]]*listen .*(default_server|reuseport)'

check "full, legacy listen http2 (nginx before 1.25.1), origin pulls on" \
  LOOMCAST_NGINX_HTTP2=listen LOOMCAST_ORIGIN_PULLS=1
expect '^    listen 443 ssl http2;$'
reject '^[[:space:]]*http2 on;'
expect 'ssl_verify_client on;'

check "full, http2 off, origin pulls on" LOOMCAST_NGINX_HTTP2=off LOOMCAST_ORIGIN_PULLS=1
expect '^    listen 443 ssl;$'
reject '^[[:space:]]*(listen .*http2|http2 on;)'

echo "== rendered site (full, http2 auto)"
env sh "$render" -o "$site"
cat "$site"
nginx -t 2>&1
echo "ALL NGINX CHECKS PASSED"
EOF

docker run --rm --network none \
  --name "loomcast-nginx-test-$$" \
  -v "$repo_root/infra:/src:ro" \
  -v "$work/cert:/etc/letsencrypt/live/$domain:ro" \
  -v "$work/ca:/ca:ro" \
  -v "$work/fixtures:/fixtures:ro" \
  -v "$work/run.sh:/run.sh:ro" \
  --entrypoint sh \
  "$image" /run.sh
