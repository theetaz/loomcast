# shellcheck shell=bash
# Shared helpers for backup.sh and restore.sh. Sourced, never executed.
#
# Everything here stays inside BACKUP_DIR and the Loomcast database named by the PG* variables
# (or the POSTGRES_* names from postgres.env). Nothing else on the host is touched.

BACKUP_DIR=${BACKUP_DIR:-/backups}

# Backup files are named loomcast-<UTC stamp>.dump, so names sort in time order. Rotation only
# ever looks at names matching this pattern. Used by the scripts that source this file.
# shellcheck disable=SC2034
BACKUP_NAME_RE='^loomcast-[0-9]{8}T[0-9]{6}Z\.dump$'

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# Logs the message, records it for the failure alert and exits.
die() {
  log "error: $*"
  if [ -n "${BACKUP_ERROR_FILE:-}" ]; then
    printf '%s\n' "$*" >"$BACKUP_ERROR_FILE" 2>/dev/null || true
  fi
  exit 1
}

is_true() {
  case "${1:-}" in
    1 | true | TRUE | True | yes | YES | on | ON) return 0 ;;
    *) return 1 ;;
  esac
}

# Positive integer check for counts and ports.
require_count() {
  local name=$1 value=$2
  [[ $value =~ ^[0-9]+$ ]] && [ "$((10#$value))" -ge 1 ] || die "$name must be a whole number of at least 1 (got '$value')"
}

# Formats epoch seconds in UTC. Works with busybox, GNU and BSD date.
epoch_fmt() {
  date -u -d "@$1" "+$2" 2>/dev/null || date -u -r "$1" "+$2"
}

# Current time in epoch seconds. BACKUP_NOW (epoch seconds) overrides the clock, so naming,
# the weekly copy and rotation can be tested with fake dates.
now_epoch() {
  if [ -n "${BACKUP_NOW:-}" ]; then
    [[ $BACKUP_NOW =~ ^[0-9]+$ ]] || die "BACKUP_NOW must be epoch seconds (got '$BACKUP_NOW')"
    printf '%s\n' "$BACKUP_NOW"
  else
    date -u +%s
  fi
}

# Refuses to work in a directory that is clearly not a dedicated backup directory.
check_backup_dir() {
  case "$BACKUP_DIR" in
    "" | / | /bin | /etc | /home | /lib | /opt | /proc | /root | /sbin | /sys | /tmp | /usr | /var)
      die "BACKUP_DIR '$BACKUP_DIR' is not a dedicated backup directory"
      ;;
  esac
  [ -d "$BACKUP_DIR" ] || die "BACKUP_DIR '$BACKUP_DIR' does not exist; create it first (see the runbook)"
  [ -w "$BACKUP_DIR" ] || die "BACKUP_DIR '$BACKUP_DIR' is not writable by uid $(id -u)"
}

# Connection settings. compose passes postgres.env as well, so the POSTGRES_* names work as
# fallbacks and the password is kept in one file only.
pg_env() {
  export PGHOST=${PGHOST:-postgres}
  export PGPORT=${PGPORT:-5432}
  export PGUSER=${PGUSER:-${POSTGRES_USER:-}}
  export PGDATABASE=${PGDATABASE:-${POSTGRES_DB:-}}
  if [ -z "${PGPASSWORD:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ]; then
    export PGPASSWORD=$POSTGRES_PASSWORD
  fi
  unset POSTGRES_PASSWORD
  export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-10}
  export PGAPPNAME=${PGAPPNAME:-loomcast-backup}
  [ -n "$PGUSER" ] || die "PGUSER (or POSTGRES_USER) is not set"
  [ -n "$PGDATABASE" ] || die "PGDATABASE (or POSTGRES_DB) is not set"
}

# Posts a failure to ALERT_WEBHOOK_URL when it is set. Formats: json (default), ntfy, slack.
# Never fails the caller and never logs the URL.
alert() {
  local title=$1 message=$2 body
  [ -n "${ALERT_WEBHOOK_URL:-}" ] || return 0
  case "${ALERT_WEBHOOK_FORMAT:-json}" in
    ntfy)
      curl -fsS -o /dev/null -m 15 --retry 2 \
        -H "Title: $title" -H "Priority: high" -H "Tags: loomcast,backup" \
        --data-binary "$message" "$ALERT_WEBHOOK_URL"
      ;;
    slack)
      body=$(jq -nc --arg text "$title: $message" '{text: $text}')
      curl -fsS -o /dev/null -m 15 --retry 2 -H 'Content-Type: application/json' \
        --data-binary "$body" "$ALERT_WEBHOOK_URL"
      ;;
    *)
      body=$(jq -nc --arg title "$title" --arg message "$message" \
        --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{source: "loomcast-backup", key: "backup.failed", level: "error", title: $title, message: $message, at: $at}')
      curl -fsS -o /dev/null -m 15 --retry 2 -H 'Content-Type: application/json' \
        --data-binary "$body" "$ALERT_WEBHOOK_URL"
      ;;
  esac || log "warning: the alert webhook call failed"
}

# Writes a file atomically: content from stdin goes to a temporary name, then is renamed.
write_atomic() {
  local target=$1 mode=$2
  cat >"$target.tmp" || return 1
  chmod "$mode" "$target.tmp" && mv -f "$target.tmp" "$target"
}

# Object storage (Cloudflare R2 in production; any S3 API works). The scoped credentials come
# from BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY and are handed to the CLI through
# its environment only.
s3_env() {
  BACKUP_S3_BUCKET=${BACKUP_S3_BUCKET:-loomcast-backups}
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] || die "BACKUP_S3_ENDPOINT is not set"
  export AWS_ACCESS_KEY_ID=${BACKUP_S3_ACCESS_KEY_ID:-${AWS_ACCESS_KEY_ID:-}}
  export AWS_SECRET_ACCESS_KEY=${BACKUP_S3_SECRET_ACCESS_KEY:-${AWS_SECRET_ACCESS_KEY:-}}
  export AWS_DEFAULT_REGION=${BACKUP_S3_REGION:-auto}
  [ -n "$AWS_ACCESS_KEY_ID" ] || die "BACKUP_S3_ACCESS_KEY_ID is not set"
  [ -n "$AWS_SECRET_ACCESS_KEY" ] || die "BACKUP_S3_SECRET_ACCESS_KEY is not set"
}

s3() {
  aws --endpoint-url "$BACKUP_S3_ENDPOINT" "$@"
}
