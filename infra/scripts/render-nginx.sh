#!/bin/sh
# Renders infra/nginx/loomcast.conf.template into an nginx site file.
#
# Usage:
#   render-nginx.sh [--compose-env FILE] [-o OUTPUT]
#
# Settings come from the environment:
#   LOOMCAST_HTTP_PORT     required, or read from the file given with --compose-env
#   LOOMCAST_DOMAIN        default loomcast.prabhavalabs.com
#   LOOMCAST_NGINX_MODE    full (default) or bootstrap: port 80 only, for the first certificate
#   LOOMCAST_NGINX_HTTP2   auto (default), on ("http2 on;", nginx >= 1.25.1), listen (legacy
#                          "listen 443 ssl http2", nginx < 1.25.1) or off
#   LOOMCAST_ORIGIN_PULLS  0 (default) or 1: require Cloudflare's origin-pull client certificate
#   LOOMCAST_ACME_ROOT     default /var/www/loomcast-acme
#   LOOMCAST_CERT_DIR      default /etc/letsencrypt/live/$LOOMCAST_DOMAIN
#   LOOMCAST_NGINX_DIR     default /etc/nginx/loomcast
#   LOOMCAST_LOG_DIR       default /var/log/nginx
#
# Writes to stdout, or atomically to OUTPUT with -o. Needs envsubst (Debian/Ubuntu: gettext-base).
# The script only renders; it never reloads nginx.
set -eu

die() {
  printf 'render-nginx: %s\n' "$*" >&2
  exit 1
}

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
template="${LOOMCAST_NGINX_TEMPLATE:-$script_dir/../nginx/loomcast.conf.template}"
output=""
compose_env=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -o | --output)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      output=$2
      shift 2
      ;;
    --compose-env)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      compose_env=$2
      shift 2
      ;;
    -h | --help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v envsubst >/dev/null 2>&1 || die "envsubst not found (Debian/Ubuntu package gettext-base)"
[ -r "$template" ] || die "template not readable: $template"

# Read only LOOMCAST_HTTP_PORT from the compose env file; never source it.
if [ -n "$compose_env" ] && [ -z "${LOOMCAST_HTTP_PORT:-}" ]; then
  [ -r "$compose_env" ] || die "compose env file not readable: $compose_env"
  LOOMCAST_HTTP_PORT=$(sed -n 's/^LOOMCAST_HTTP_PORT=\([0-9]*\)[[:space:]]*$/\1/p' "$compose_env" | tail -n 1)
fi

LOOMCAST_HTTP_PORT=${LOOMCAST_HTTP_PORT:-}
LOOMCAST_DOMAIN=${LOOMCAST_DOMAIN:-loomcast.prabhavalabs.com}
LOOMCAST_NGINX_MODE=${LOOMCAST_NGINX_MODE:-full}
LOOMCAST_NGINX_HTTP2=${LOOMCAST_NGINX_HTTP2:-auto}
LOOMCAST_ORIGIN_PULLS=${LOOMCAST_ORIGIN_PULLS:-0}
LOOMCAST_ACME_ROOT=${LOOMCAST_ACME_ROOT:-/var/www/loomcast-acme}
LOOMCAST_CERT_DIR=${LOOMCAST_CERT_DIR:-/etc/letsencrypt/live/$LOOMCAST_DOMAIN}
LOOMCAST_NGINX_DIR=${LOOMCAST_NGINX_DIR:-/etc/nginx/loomcast}
LOOMCAST_LOG_DIR=${LOOMCAST_LOG_DIR:-/var/log/nginx}

# --- validation -------------------------------------------------------------------------------

case "$LOOMCAST_HTTP_PORT" in
  '' | *[!0-9]*) die "LOOMCAST_HTTP_PORT must be set to a port number" ;;
esac
if [ "$LOOMCAST_HTTP_PORT" -lt 1024 ] || [ "$LOOMCAST_HTTP_PORT" -gt 65535 ]; then
  die "LOOMCAST_HTTP_PORT must be between 1024 and 65535"
fi

printf '%s\n' "$LOOMCAST_DOMAIN" |
  grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' ||
  die "LOOMCAST_DOMAIN is not a lowercase hostname: $LOOMCAST_DOMAIN"

for path_var in LOOMCAST_ACME_ROOT LOOMCAST_CERT_DIR LOOMCAST_NGINX_DIR LOOMCAST_LOG_DIR; do
  eval "path_value=\$$path_var"
  # shellcheck disable=SC2154 # assigned by the eval above
  printf '%s\n' "$path_value" | grep -Eq '^/[A-Za-z0-9._/-]*$' ||
    die "$path_var must be an absolute path without spaces or special characters"
done

case "$LOOMCAST_NGINX_MODE" in
  full | bootstrap) ;;
  *) die "LOOMCAST_NGINX_MODE must be full or bootstrap" ;;
esac

case "$LOOMCAST_ORIGIN_PULLS" in
  0 | 1) ;;
  *) die "LOOMCAST_ORIGIN_PULLS must be 0 or 1" ;;
esac

# nginx 1.25.1 moved HTTP/2 from a listen parameter (which applies to every site on the socket)
# to a per-server "http2 on;". auto picks the per-server form when the local nginx supports it
# and otherwise leaves HTTP/2 off, so other sites on port 443 are never changed.
if [ "$LOOMCAST_NGINX_HTTP2" = auto ]; then
  LOOMCAST_NGINX_HTTP2=off
  if command -v nginx >/dev/null 2>&1; then
    version=$(nginx -v 2>&1 | sed -n 's|.*nginx/\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\).*|\1 \2 \3|p')
    if [ -n "$version" ]; then
      # shellcheck disable=SC2086 # split the three numbers on purpose
      set -- $version
      if [ $(($1 * 1000000 + $2 * 1000 + $3)) -ge 1025001 ]; then
        LOOMCAST_NGINX_HTTP2=on
      fi
    fi
  fi
fi

blocks=""
LOOMCAST_LISTEN_HTTP2=""
case "$LOOMCAST_NGINX_HTTP2" in
  on) blocks="$blocks http2" ;;
  listen) LOOMCAST_LISTEN_HTTP2=" http2" ;;
  off) ;;
  *) die "LOOMCAST_NGINX_HTTP2 must be auto, on, listen or off" ;;
esac
[ "$LOOMCAST_NGINX_MODE" = full ] && blocks="$blocks tls"
[ "$LOOMCAST_ORIGIN_PULLS" = 1 ] && blocks="$blocks origin-pulls"

export LOOMCAST_HTTP_PORT LOOMCAST_DOMAIN LOOMCAST_ACME_ROOT LOOMCAST_CERT_DIR \
  LOOMCAST_NGINX_DIR LOOMCAST_LOG_DIR LOOMCAST_LISTEN_HTTP2

# --- render -----------------------------------------------------------------------------------

# Keep the blocks named in $blocks, drop the others (and anything nested in them), and remove the
# marker lines. Only the listed variables are substituted, so nginx's own $variables stay intact.
# shellcheck disable=SC2016 # envsubst takes the variable names literally
substituted='${LOOMCAST_HTTP_PORT} ${LOOMCAST_DOMAIN} ${LOOMCAST_ACME_ROOT} ${LOOMCAST_CERT_DIR}
${LOOMCAST_NGINX_DIR} ${LOOMCAST_LOG_DIR} ${LOOMCAST_LISTEN_HTTP2}'

render() {
  awk -v enabled="$blocks" '
    BEGIN { n = split(enabled, names, " "); for (i = 1; i <= n; i++) on[names[i]] = 1; skip = 0 }
    /^[[:space:]]*# @begin [a-z0-9-]+[[:space:]]*$/ {
      if (skip > 0 || !($3 in on)) skip++
      next
    }
    /^[[:space:]]*# @end [a-z0-9-]+[[:space:]]*$/ {
      if (skip > 0) skip--
      next
    }
    skip == 0 { print }
  ' "$template" | envsubst "$substituted"
}

# With -o, render next to the output so the final rename is atomic. The leading dot keeps the
# temporary file out of nginx's "include sites-enabled/*" glob.
if [ -n "$output" ]; then
  tmp=$(mktemp "$(dirname -- "$output")/.loomcast-nginx.XXXXXX")
else
  tmp=$(mktemp "${TMPDIR:-/tmp}/loomcast-nginx.XXXXXX")
fi
trap 'rm -f "$tmp"' EXIT HUP INT TERM

{
  printf '# Rendered from infra/nginx/loomcast.conf.template (mode %s, http2 %s, origin pulls %s).\n' \
    "$LOOMCAST_NGINX_MODE" "$LOOMCAST_NGINX_HTTP2" "$LOOMCAST_ORIGIN_PULLS"
  render
} >"$tmp"

if grep -n -E -e '\$\{?LOOMCAST_' -e '^[[:space:]]*# @(begin|end) ' "$tmp" >&2; then
  die "rendering left placeholders or block markers behind"
fi

if [ -z "$output" ]; then
  cat "$tmp"
else
  chmod 0644 "$tmp"
  mv -f "$tmp" "$output"
fi
