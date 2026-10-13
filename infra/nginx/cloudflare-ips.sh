#!/bin/sh
# Writes the nginx include that lists Cloudflare's published address ranges as trusted proxies
# (set_real_ip_from), for the Loomcast site's "real_ip_header CF-Connecting-IP".
#
# Usage:
#   cloudflare-ips.sh [-o OUTPUT] [--reload]
#   cloudflare-ips.sh --v4-file FILE --v6-file FILE [-o OUTPUT]     (offline, for tests)
#
#   -o OUTPUT   default /etc/nginx/loomcast/cloudflare-ips.conf; "-" writes to stdout
#   --reload    when the file changed: run "nginx -t" and reload nginx; on a failed test the
#               previous file is put back and nothing is reloaded
#
# The ranges are fetched at run time from https://www.cloudflare.com/ips-v4/ and /ips-v6/ (no
# credentials needed). Every line must be a CIDR range; on any error the existing include is left
# untouched, so a failed refresh never empties the trusted list.
set -eu

die() {
  printf 'cloudflare-ips: %s\n' "$*" >&2
  exit 1
}

V4_URL="https://www.cloudflare.com/ips-v4/"
V6_URL="https://www.cloudflare.com/ips-v6/"

output="/etc/nginx/loomcast/cloudflare-ips.conf"
v4_file=""
v6_file=""
reload=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -o | --output)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      output=$2
      shift 2
      ;;
    --v4-file)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      v4_file=$2
      shift 2
      ;;
    --v6-file)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      v6_file=$2
      shift 2
      ;;
    --reload)
      reload=1
      shift
      ;;
    -h | --help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [ -n "$v4_file" ] || [ -n "$v6_file" ]; then
  [ -n "$v4_file" ] && [ -n "$v6_file" ] || die "--v4-file and --v6-file go together"
fi
[ "$reload" = 0 ] || [ "$output" != "-" ] || die "--reload needs an output file"

work=$(mktemp -d "${TMPDIR:-/tmp}/loomcast-cf-ips.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM

fetch() {
  command -v curl >/dev/null 2>&1 || die "curl not found"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --max-time 30 --retry 3 --output "$2" "$1" || die "could not fetch $1"
}

if [ -n "$v4_file" ]; then
  cp "$v4_file" "$work/v4.raw" || die "cannot read $v4_file"
  cp "$v6_file" "$work/v6.raw" || die "cannot read $v6_file"
else
  fetch "$V4_URL" "$work/v4.raw"
  fetch "$V6_URL" "$work/v6.raw"
fi

# Normalise (strip CR and surrounding blanks, drop empty lines; the published lists have no final
# newline) and refuse anything that is not a CIDR range of the expected family.
normalise() {
  tr -d '\r' <"$1" | awk '{ gsub(/^[ \t]+|[ \t]+$/, ""); if (length($0) > 0) print }'
}

normalise "$work/v4.raw" >"$work/v4"
normalise "$work/v6.raw" >"$work/v6"

v4_re='^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}/([0-9]|[12][0-9]|3[0-2])$'
v6_re='^[0-9a-fA-F:]*:[0-9a-fA-F:]*/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$'

[ -s "$work/v4" ] || die "the IPv4 list is empty"
[ -s "$work/v6" ] || die "the IPv6 list is empty"
if bad=$(grep -Ev "$v4_re" "$work/v4"); then
  die "unexpected line in the IPv4 list: $(printf '%s' "$bad" | head -n 1)"
fi
if bad=$(grep -Ev "$v6_re" "$work/v6"); then
  die "unexpected line in the IPv6 list: $(printf '%s' "$bad" | head -n 1)"
fi

{
  printf '# Cloudflare address ranges, trusted for CF-Connecting-IP by the Loomcast site.\n'
  printf '# Written by infra/nginx/cloudflare-ips.sh; do not edit. Refresh with the same script.\n'
  sort -u "$work/v4" | awk '{ printf "set_real_ip_from %s;\n", $0 }'
  sort -u "$work/v6" | awk '{ printf "set_real_ip_from %s;\n", $0 }'
} >"$work/include.conf"

if [ "$output" = "-" ]; then
  cat "$work/include.conf"
  exit 0
fi

out_dir=$(dirname -- "$output")
[ -d "$out_dir" ] || die "directory does not exist: $out_dir"

if [ -f "$output" ] && cmp -s "$work/include.conf" "$output"; then
  printf 'cloudflare-ips: %s is up to date\n' "$output" >&2
  exit 0
fi

backup=""
if [ -f "$output" ]; then
  backup="$work/previous.conf"
  cp -p "$output" "$backup"
fi

# Stage next to the target so the rename is atomic.
staged=$(mktemp "$out_dir/.cloudflare-ips.XXXXXX")
cp "$work/include.conf" "$staged"
chmod 0644 "$staged"
mv -f "$staged" "$output"
printf 'cloudflare-ips: wrote %s\n' "$output" >&2

if [ "$reload" = 1 ]; then
  if nginx -t >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl reload nginx
    else
      nginx -s reload
    fi
    printf 'cloudflare-ips: nginx reloaded\n' >&2
  else
    if [ -n "$backup" ]; then
      cp -p "$backup" "$output"
    else
      rm -f "$output"
    fi
    die "nginx -t failed with the new ranges; the previous file was restored and nginx not reloaded"
  fi
fi
