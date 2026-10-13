#!/usr/bin/env bash
# Nightly backups of the Loomcast database.
#
#   backup.sh run    (default) wait until BACKUP_AT (HH:MM, UTC), back up, repeat every day
#   backup.sh once   back up now and exit
#   backup.sh next   print when the next scheduled backup runs, then exit
#
# A backup is a custom-format pg_dump (-Fc -Z6) written to BACKUP_DIR/daily/ under a temporary
# name, checked with pg_restore --list, renamed, and given a .sha256 file. On BACKUP_WEEKLY_DAY
# (default 7, Sunday) it is also kept in BACKUP_DIR/weekly/. Rotation keeps the newest
# BACKUP_KEEP_DAILY daily and BACKUP_KEEP_WEEKLY weekly backups and deletes only files whose
# names match loomcast-<stamp>.dump(.sha256) in those two directories. A successful run writes
# BACKUP_DIR/last-success.json; a failed one writes last-failure.json and calls the alert
# webhook when ALERT_WEBHOOK_URL is set.
#
# BACKUP_NOW (epoch seconds) replaces the clock for naming and rotation; the drill uses it.
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

BACKUP_AT=${BACKUP_AT:-02:30}
BACKUP_KEEP_DAILY=${BACKUP_KEEP_DAILY:-14}
BACKUP_KEEP_WEEKLY=${BACKUP_KEEP_WEEKLY:-8}
BACKUP_WEEKLY_DAY=${BACKUP_WEEKLY_DAY:-7}

usage() {
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
}

check_backup_at() {
  [[ $BACKUP_AT =~ ^([01][0-9]|2[0-3]):([0-5][0-9])$ ]] || die "BACKUP_AT must be HH:MM in UTC (got '$BACKUP_AT')"
}

# Prints the epoch of the next BACKUP_AT strictly after the given epoch.
next_run_epoch() {
  local now=$1 hour minute day target
  check_backup_at
  hour=$((10#${BASH_REMATCH[1]}))
  minute=$((10#${BASH_REMATCH[2]}))
  day=$((now - now % 86400))
  target=$((day + hour * 3600 + minute * 60))
  if [ "$target" -le "$now" ]; then
    target=$((target + 86400))
  fi
  printf '%s\n' "$target"
}

# Lists backup names (not paths) in a directory, oldest first.
list_backups() {
  local dir=$1 path name
  for path in "$dir"/loomcast-*.dump; do
    [ -f "$path" ] || continue
    name=${path##*/}
    if [[ $name =~ $BACKUP_NAME_RE ]]; then
      printf '%s\n' "$name"
    fi
  done | sort
}

# Keeps the newest $2 backups in directory $1 and deletes the rest with their checksums.
rotate_dir() {
  local dir=$1 keep=$2 names count remove name path
  names=$(list_backups "$dir")
  count=$(printf '%s' "$names" | grep -c . || true)
  remove=$((count - keep))
  if [ "$remove" -gt 0 ]; then
    while IFS= read -r name; do
      log "rotation: deleting ${dir##*/}/$name"
      rm -f -- "$dir/$name" "$dir/$name.sha256"
    done < <(printf '%s\n' "$names" | head -n "$remove")
  fi
  # Checksums whose backup is gone (for example after a manual delete).
  for path in "$dir"/loomcast-*.dump.sha256; do
    [ -f "$path" ] || continue
    name=${path##*/}
    name=${name%.sha256}
    if [[ $name =~ $BACKUP_NAME_RE ]] && [ ! -e "$dir/$name" ]; then
      rm -f -- "$path"
    fi
  done
}

backup_once() {
  local now stamp day name daily weekly tmp sum bytes started weekly_copy=false

  pg_env
  check_backup_dir
  require_count BACKUP_KEEP_DAILY "$BACKUP_KEEP_DAILY"
  require_count BACKUP_KEEP_WEEKLY "$BACKUP_KEEP_WEEKLY"
  [[ $BACKUP_WEEKLY_DAY =~ ^[1-7]$ ]] || die "BACKUP_WEEKLY_DAY must be 1 (Monday) to 7 (Sunday)"

  umask 077
  daily=$BACKUP_DIR/daily
  weekly=$BACKUP_DIR/weekly
  mkdir -p "$daily" "$weekly"

  # One backup at a time, even when an operator runs `once` next to the scheduled loop.
  exec 9>"$BACKUP_DIR/.lock"
  flock -n 9 || die "another backup is running"

  # Partial dumps left by a container that was killed mid-run.
  rm -f -- "$daily"/loomcast-*.dump.tmp "$daily"/loomcast-*.dump.tmp.log

  started=$(date -u +%s)
  now=$(now_epoch)
  stamp=$(epoch_fmt "$now" %Y%m%dT%H%M%SZ)
  day=$(epoch_fmt "$now" %Y%m%d)
  name=loomcast-$stamp.dump
  tmp=$daily/$name.tmp
  [ ! -e "$daily/$name" ] || die "a backup named $name already exists"

  log "dumping database '$PGDATABASE' on $PGHOST:$PGPORT to daily/$name"
  trap 'rm -f -- "$tmp" "$tmp.log"' EXIT
  if ! pg_dump --format=custom --compress=6 --no-password --file="$tmp" 2>"$tmp.log"; then
    cat "$tmp.log" >&2
    die "pg_dump failed: $(tail -n 1 "$tmp.log")"
  fi
  cat "$tmp.log" >&2
  [ -s "$tmp" ] || die "pg_dump wrote an empty file"
  pg_restore --list "$tmp" >/dev/null || die "the dump is not a readable archive"
  mv -- "$tmp" "$daily/$name"
  rm -f -- "$tmp.log"
  trap - EXIT

  sum=$(sha256sum "$daily/$name" | cut -d' ' -f1)
  printf '%s  %s\n' "$sum" "$name" | write_atomic "$daily/$name.sha256" 600
  bytes=$(wc -c <"$daily/$name" | tr -d ' ')
  log "dump complete: $bytes bytes, sha256 $sum"

  # Weekly copy: one per week, taken from the first backup on the configured weekday. A hard
  # link costs no space; copy when the filesystem refuses links.
  if [ "$(epoch_fmt "$now" %u)" = "$BACKUP_WEEKLY_DAY" ] &&
    ! compgen -G "$weekly/loomcast-${day}T*.dump" >/dev/null; then
    ln -- "$daily/$name" "$weekly/$name" 2>/dev/null || cp -p -- "$daily/$name" "$weekly/$name"
    cp -p -- "$daily/$name.sha256" "$weekly/$name.sha256"
    weekly_copy=true
    log "weekly copy: weekly/$name"
  fi

  rotate_dir "$daily" "$((10#$BACKUP_KEEP_DAILY))"
  rotate_dir "$weekly" "$((10#$BACKUP_KEEP_WEEKLY))"

  jq -n \
    --arg at "$(epoch_fmt "$now" %Y-%m-%dT%H:%M:%SZ)" \
    --argjson bytes "$bytes" \
    --arg sha256 "$sum" \
    --arg file "daily/$name" \
    --argjson weekly "$weekly_copy" \
    --argjson durationSeconds "$(($(date -u +%s) - started))" \
    '{at: $at, bytes: $bytes, sha256: $sha256, file: $file, weekly: $weekly, durationSeconds: $durationSeconds}' |
    write_atomic "$BACKUP_DIR/last-success.json" 644
  rm -f -- "$BACKUP_DIR/last-failure.json"
  log "backup succeeded: daily/$name"
}

# Runs one backup in a subshell so a failure is reported without stopping the schedule. The
# result goes to RUN_STATUS: calling this in a condition would switch off errexit inside it.
RUN_STATUS=0
run_once() {
  local errors reason
  errors=$(mktemp)
  set +e
  (
    set -e
    BACKUP_ERROR_FILE=$errors backup_once
  )
  RUN_STATUS=$?
  set -e
  if [ "$RUN_STATUS" -ne 0 ]; then
    reason=$(head -n 1 "$errors" 2>/dev/null || true)
    reason=${reason:-exit status $RUN_STATUS}
    if [ -d "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ]; then
      jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg error "$reason" '{at: $at, error: $error}' |
        write_atomic "$BACKUP_DIR/last-failure.json" 644 || true
    fi
    alert "Loomcast backup failed" "$reason"
  fi
  rm -f -- "$errors"
}

run_loop() {
  local next now wait sleeper=
  trap 'log "stopping"; [ -n "$sleeper" ] && kill "$sleeper" 2>/dev/null; exit 0' TERM INT
  check_backup_at
  log "scheduler started: daily at $BACKUP_AT UTC, keeping $BACKUP_KEEP_DAILY daily and $BACKUP_KEEP_WEEKLY weekly backups"
  while true; do
    next=$(next_run_epoch "$(date -u +%s)")
    log "next backup at $(epoch_fmt "$next" %Y-%m-%dT%H:%M:%SZ)"
    # Wake at least every five minutes so clock changes are picked up.
    while now=$(date -u +%s) && [ "$now" -lt "$next" ]; do
      wait=$((next - now))
      [ "$wait" -le 300 ] || wait=300
      sleep "$wait" &
      sleeper=$!
      wait "$sleeper" || true
      sleeper=
    done
    run_once
    [ "$RUN_STATUS" -eq 0 ] || log "backup failed; next attempt at the next scheduled time"
  done
}

case "${1:-run}" in
  run) run_loop ;;
  once)
    run_once
    exit "$RUN_STATUS"
    ;;
  next)
    check_backup_at
    now=$(now_epoch)
    epoch_fmt "$(next_run_epoch "$now")" %Y-%m-%dT%H:%M:%SZ
    ;;
  -h | --help | help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
