#!/usr/bin/env bash
# Backup and restore drill against the local development stack (`pnpm stack:up`).
#
#   bash infra/backup/test/drill.sh
#
# It builds the backup image under a throwaway tag and runs every step in it with the
# production limits (128 MiB, read-only root filesystem, no capabilities, uid 70):
#   1. creates a scratch database next to the dev database and seeds it
#   2. backs it up and checks the checksum file and last-success.json
#   3. restores into a second scratch database and compares row counts and a data fingerprint
#   4. checks that a bad checksum or a restore over the source database is refused
#   5. --into-production with the scratch database standing in for production: refused while
#      another session is connected, then swapped by renaming, with the old copy kept
#   6. rotation with fake dates: 70 daily runs keep exactly 14 daily and 8 weekly (Sunday)
#      backups and leave unrelated files alone; smaller limits are honoured too
#   7. when the local object store answers: an encrypted upload with an age key generated for
#      this run into a scratch bucket, then a restore from that bucket
# Everything it creates (databases, volumes, bucket, key, image) is removed on exit. The
# `loomcast` dev database and the stack's containers are never changed.
#
# Environment:
#   DRILL_ADMIN_URL    admin connection URL (default TEST_DATABASE_ADMIN_URL from .env.example)
#   DRILL_S3           auto (default: run step 6 when the store answers), 1 (require it) or 0
#   DRILL_S3_ENDPOINT  object store URL (default S3_ENDPOINT from .env.example)
#   DRILL_IMAGE        run an existing image instead of building a throwaway one
#
# Works with the bash 3.2 that ships with macOS.

# The single-quoted scripts below run inside the container and expand there, on purpose.
# shellcheck disable=SC2016
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
BACKUP_CONTEXT=$ROOT/infra/backup

step() { printf '\n==> %s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

# Reads a value from the repository's .env.example (no credentials are written in this file).
env_example() {
  sed -n "s/^$1=//p" "$ROOT/.env.example" | head -n 1
}

# --- Connection settings --------------------------------------------------------------------

admin_url=${DRILL_ADMIN_URL:-${TEST_DATABASE_ADMIN_URL:-$(env_example TEST_DATABASE_ADMIN_URL)}}
[ -n "$admin_url" ] || fail "no admin URL: set DRILL_ADMIN_URL"
rest=${admin_url#*://}
userinfo=${rest%@*}
hostpart=${rest##*@}
hostport=${hostpart%%/*}
MAINT_DB=${hostpart#*/}
MAINT_DB=${MAINT_DB%%\?*}
export PGUSER=${userinfo%%:*}
export PGPASSWORD=${userinfo#*:}
export PGPORT=${hostport##*:}
pg_host=${hostport%%:*}

# Containers reach the host's loopback through host.docker.internal on Docker Desktop and
# through the host network on Linux.
container_host() {
  case "$1" in
    127.0.0.1 | localhost) if [ "$(uname -s)" = Darwin ]; then echo host.docker.internal; else echo "$1"; fi ;;
    *) echo "$1" ;;
  esac
}
if [ "$(uname -s)" = Darwin ]; then
  NET_OPT=--add-host=host.docker.internal:host-gateway
else
  NET_OPT=--network=host
fi
export PGHOST
PGHOST=$(container_host "$pg_host")

# --- Names: everything this run creates carries its id ------------------------------------

# Short enough that <name>_pre_restore_<stamp> stays within the 63-character name limit.
ID=$(date -u +%H%M%S)$$
SRC_DB=loomcast_drill_$ID
RESTORE_DB=${SRC_DB}_restore
TAMPER_DB=${SRC_DB}_tamper
S3_DB=${SRC_DB}_s3
# SRC_DB as a LIKE prefix (underscores escaped).
SRC_LIKE=$(printf '%s' "$SRC_DB" | sed 's/_/\\_/g')
HOLDER=loomcast-backup-drill-$ID-session
VOL=loomcast-backup-drill-$ID
VOL_ROT=$VOL-rotation
VOL_S3=$VOL-s3
BUCKET=loomcast-backup-drill-$ID
IMAGE=${DRILL_IMAGE:-loomcast-backup:drill-$ID}
built_image=false
bucket_created=false

# Runs a command in the backup image with the production limits and volume $1 on /backups.
dr() {
  local vol=$1
  shift
  docker run --rm --init --user 70:70 --memory 128m --memory-swap 128m --read-only \
    --tmpfs /tmp:size=32m,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 64 "$NET_OPT" -v "$vol:/backups" \
    -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD \
    -e BACKUP_S3_ENDPOINT -e BACKUP_S3_BUCKET -e BACKUP_S3_ACCESS_KEY_ID -e BACKUP_S3_SECRET_ACCESS_KEY \
    "$IMAGE" "$@"
}

# Same, with standard input attached (for SQL heredocs).
dri() {
  local vol=$1
  shift
  docker run --rm -i --user 70:70 --memory 128m --read-only --tmpfs /tmp:size=32m,mode=1777 \
    --cap-drop ALL "$NET_OPT" -v "$vol:/backups" -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD \
    "$IMAGE" "$@"
}

# Runs a command that must fail, and checks that its error output names the reason.
expect_refusal() {
  local reason=$1 output
  shift
  if output=$("$@" 2>&1); then
    fail "expected a refusal ($reason), but the command succeeded"
  fi
  case "$output" in
    *"$reason"*) ;;
    *)
      printf '%s\n' "$output" >&2
      fail "expected a refusal mentioning '$reason'"
      ;;
  esac
}

sql() {
  local db=$1
  shift
  dr "$VOL" psql -X -q -At -v ON_ERROR_STOP=1 -d "$db" "$@"
}

# The S3 command line client against the scratch bucket's endpoint.
daws() {
  dr "$VOL_S3" sh -c '
    export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
    exec aws --endpoint-url "$BACKUP_S3_ENDPOINT" "$@"
  ' aws "$@"
}

cleanup() {
  local status=$? db
  set +e
  step "cleanup"
  if [ "$bucket_created" = true ]; then
    daws s3 rm --quiet --recursive "s3://$BUCKET" >/dev/null 2>&1
    daws s3api delete-bucket --bucket "$BUCKET" >/dev/null 2>&1 && echo "removed bucket $BUCKET"
  fi
  docker rm -f "$HOLDER" >/dev/null 2>&1
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    # Every database whose name starts with this run's source database, and nothing else.
    for db in $(sql "$MAINT_DB" -c "select datname from pg_database where datname like '$SRC_LIKE%'" 2>/dev/null); do
      case "$db" in "$SRC_DB"*) sql "$MAINT_DB" -c "drop database if exists \"$db\"" >/dev/null 2>&1 && echo "dropped $db" ;; esac
    done
  fi
  docker volume rm -f "$VOL" "$VOL_ROT" "$VOL_S3" >/dev/null 2>&1 && echo "removed the drill volumes"
  if [ "$built_image" = true ]; then
    docker image rm -f "$IMAGE" >/dev/null 2>&1 && echo "removed image $IMAGE"
  fi
  if [ "$status" -eq 0 ]; then
    printf '\ndrill passed\n'
  else
    printf '\ndrill FAILED (exit %s)\n' "$status" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

# --- 0. Image and database --------------------------------------------------------------

step "0/7 build the backup image and reach the dev Postgres on $pg_host:$PGPORT"
if [ -z "${DRILL_IMAGE:-}" ]; then
  docker build -q -t "$IMAGE" "$BACKUP_CONTEXT" >/dev/null
  built_image=true
fi
docker volume create "$VOL" >/dev/null
dr "$VOL" pg_isready -q -d "$MAINT_DB" -t 10 || fail "Postgres is not reachable; run pnpm stack:up"
pass "image $IMAGE, Postgres $(sql "$MAINT_DB" -c 'show server_version')"

# --- 1. Seed ---------------------------------------------------------------------------------

step "1/7 seed the scratch database $SRC_DB"
sql "$MAINT_DB" -c "create database \"$SRC_DB\""
dri "$VOL" psql -X -q -v ON_ERROR_STOP=1 -d "$SRC_DB" <<'SQL'
create extension if not exists pg_trgm;
create schema drill;
create table drill.projects (
  id bigserial primary key,
  name text not null unique,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table drill.items (
  id bigserial primary key,
  project_id bigint not null references drill.projects (id),
  body text not null,
  blob bytea,
  state text not null default 'idea'
);
create index items_body_trgm on drill.items using gin (body gin_trgm_ops);
create table public.drill_empty (id int primary key);
insert into drill.projects (name, meta)
  select 'project ' || g, jsonb_build_object('n', g, 'tags', jsonb_build_array('a', 'b'))
  from generate_series(1, 25) g;
insert into drill.items (project_id, body, blob, state)
  select 1 + g % 25, 'item ' || md5(g::text), decode(md5(g::text), 'hex'),
         (array['idea', 'drafting', 'rendering', 'published'])[1 + g % 4]
  from generate_series(1, 5000) g;
SQL

fingerprint() {
  sql "$1" -c "select concat_ws(' ',
    (select count(*) from drill.items),
    (select md5(string_agg(format('%s|%s|%s|%s|%s', id, project_id, body, encode(blob, 'hex'), state), ',' order by id)) from drill.items),
    (select md5(string_agg(format('%s|%s|%s|%s', id, name, meta, created_at), ',' order by id)) from drill.projects),
    (select last_value from drill.items_id_seq),
    (select count(*) from pg_indexes where schemaname = 'drill'))"
}
source_fingerprint=$(fingerprint "$SRC_DB")
pass "seeded: $(sql "$SRC_DB" -c 'select count(*) from drill.items') items, $(sql "$SRC_DB" -c 'select count(*) from drill.projects') projects"

# --- 2. Back up ------------------------------------------------------------------------------

step "2/7 back up $SRC_DB"
dr "$VOL" env PGDATABASE="$SRC_DB" BACKUP_UPLOAD=false backup.sh once
dump=$(dr "$VOL" jq -r .file /backups/last-success.json)
dr "$VOL" sh -ec '
  cd /backups/daily
  sha256sum -c loomcast-*.dump.sha256
  if ls ./*.tmp >/dev/null 2>&1; then exit 1; fi
  jq -e "(.bytes > 0) and (.sha256 | length == 64) and (.at | test(\"Z$\")) and (.uploaded == null)" /backups/last-success.json >/dev/null
  test "$(jq -r .sha256 /backups/last-success.json)" = "$(cut -d" " -f1 "$(basename "$(jq -r .file /backups/last-success.json)").sha256")"
' || fail "backup files or last-success.json are wrong"
pass "backup $dump with a matching checksum and last-success.json"

# --- 3. Restore into scratch -------------------------------------------------------------

step "3/7 restore $dump into $RESTORE_DB"
dr "$VOL" env PGDATABASE="$SRC_DB" restore.sh --target-db "$RESTORE_DB" --compare-with "$SRC_DB" "/backups/$dump"
restored_fingerprint=$(fingerprint "$RESTORE_DB")
[ "$restored_fingerprint" = "$source_fingerprint" ] ||
  fail "data fingerprint differs: source '$source_fingerprint', restored '$restored_fingerprint'"
pass "row counts match for every table and the data fingerprint matches"
sql "$MAINT_DB" -c "drop database \"$RESTORE_DB\""

# --- 4. Refusals ------------------------------------------------------------------------------

step "4/7 refuse a bad checksum and a restore over the source database"
dr "$VOL" sh -ec '
  mkdir -p /backups/tamper
  cp "/backups/$1" /backups/tamper/copy.dump
  printf "%064d  copy.dump\n" 0 >/backups/tamper/copy.dump.sha256
' sh "$dump"
expect_refusal "checksum mismatch" \
  dr "$VOL" env PGDATABASE="$SRC_DB" restore.sh --target-db "$TAMPER_DB" /backups/tamper/copy.dump
[ "$(sql "$MAINT_DB" -c "select count(*) from pg_database where datname = '$TAMPER_DB'")" = 0 ] ||
  fail "a refused restore left database $TAMPER_DB behind"
expect_refusal "refusing to restore over" \
  dr "$VOL" env PGDATABASE="$SRC_DB" restore.sh --target-db "$SRC_DB" "/backups/$dump"
expect_refusal "also needs --yes-i-understand" \
  dr "$VOL" env PGDATABASE="$SRC_DB" restore.sh --into-production "/backups/$dump"
[ "$(fingerprint "$SRC_DB")" = "$source_fingerprint" ] || fail "the source database changed"
pass "wrong checksum, restore over the source and unconfirmed --into-production are refused"

# --- 5. Production restore, with the source database standing in for production -----------

step "5/7 --into-production: refuse while connected, then swap"
sql "$SRC_DB" -c "insert into drill.projects (name) values ('written after the backup')"
# An idle session on the stand-in database, like a running api.
docker run -d -i --name "$HOLDER" --user 70:70 --memory 64m "$NET_OPT" -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD \
  "$IMAGE" psql -X -q -d "$SRC_DB" >/dev/null
attempt=0
until [ "$(sql "$MAINT_DB" -c "select count(*) from pg_stat_activity where datname = '$SRC_DB'")" -ge 1 ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -le 100 ] || fail "the stand-in session did not connect"
done
expect_refusal "other session(s) are connected" \
  dr "$VOL" env PGDATABASE="$SRC_DB" restore.sh --into-production --yes-i-understand "/backups/$dump"
docker rm -f "$HOLDER" >/dev/null
attempt=0
until [ "$(sql "$MAINT_DB" -c "select count(*) from pg_stat_activity where datname = '$SRC_DB'")" = 0 ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -le 100 ] || fail "the stand-in session did not disconnect"
done
dr "$VOL" env PGDATABASE="$SRC_DB" restore.sh --into-production --yes-i-understand "/backups/$dump"
[ "$(fingerprint "$SRC_DB")" = "$source_fingerprint" ] || fail "the swapped-in database does not match the backup"
previous=$(sql "$MAINT_DB" -c "select datname from pg_database where datname like '$SRC_LIKE\\_pre\\_restore\\_%'")
[ -n "$previous" ] || fail "the previous database was not kept"
[ "$(sql "$previous" -c "select count(*) from drill.projects")" = 26 ] || fail "the kept database lost the newer row"
pass "refused with a session open; swapped in the backup and kept the old database as $previous"

# --- 6. Rotation with fake dates --------------------------------------------------------

step "6/7 rotation: 70 daily runs with fake dates"
docker volume create "$VOL_ROT" >/dev/null
# Monday 2026-07-06 02:30 UTC; the run covers ten Sundays.
base=1783305000
[ "$(dr "$VOL_ROT" date -u -d "@$base" +%u)" = 1 ] || fail "the fake start date is not a Monday"
dr "$VOL_ROT" sh -ec '
  touch /backups/notes.txt
  mkdir -p /backups/daily /backups/weekly
  touch /backups/daily/notes.txt /backups/daily/loomcast-manual.dump /backups/weekly/loomcast-old.dump.bak
'
rotation_log=$(mktemp)
if ! dr "$VOL_ROT" env PGDATABASE="$SRC_DB" BACKUP_UPLOAD=false BASE="$base" bash -ec '
  for i in $(seq 0 69); do
    BACKUP_NOW=$((BASE + i * 86400)) backup.sh once
  done
' >"$rotation_log" 2>&1; then
  tail -n 20 "$rotation_log" >&2
  rm -f "$rotation_log"
  fail "a fake-date backup failed"
fi
printf '%s fake-date runs, %s rotation deletions\n' "$(grep -c 'backup succeeded' "$rotation_log")" "$(grep -c 'rotation: deleting' "$rotation_log")"
rm -f "$rotation_log"

dr "$VOL_ROT" env BASE="$base" bash -ec '
  cd /backups
  stamp() { date -u -d "@$1" +loomcast-%Y%m%dT%H%M%SZ.dump; }
  expected_daily=$(for i in $(seq 56 69); do stamp $((BASE + i * 86400)); done)
  expected_weekly=$(for i in $(seq 0 69); do
    e=$((BASE + i * 86400))
    if [ "$(date -u -d "@$e" +%u)" = 7 ]; then stamp "$e"; fi
  done | tail -n 8)
  actual_daily=$(ls daily | grep -E "^loomcast-[0-9]{8}T[0-9]{6}Z\.dump$" | sort)
  actual_weekly=$(ls weekly | grep -E "^loomcast-[0-9]{8}T[0-9]{6}Z\.dump$" | sort)
  echo "daily:  $(echo "$actual_daily" | wc -l) backups, $(echo "$actual_daily" | head -n 1) .. $(echo "$actual_daily" | tail -n 1)"
  echo "weekly: $(echo "$actual_weekly" | wc -l) backups, $(echo "$actual_weekly" | head -n 1) .. $(echo "$actual_weekly" | tail -n 1)"
  [ "$(echo "$actual_daily" | wc -l)" -eq 14 ] || { echo "expected 14 daily backups"; exit 1; }
  [ "$(echo "$actual_weekly" | wc -l)" -eq 8 ] || { echo "expected 8 weekly backups"; exit 1; }
  [ "$actual_daily" = "$expected_daily" ] || { echo "daily backups are not the newest 14 days"; exit 1; }
  [ "$actual_weekly" = "$expected_weekly" ] || { echo "weekly backups are not the newest 8 Sundays"; exit 1; }
  for name in $actual_weekly; do [ "$(date -u -d "@$(date -u -d "$(echo "$name" | sed -E "s/loomcast-(....)(..)(..)T(..)(..)(..)Z.dump/\1-\2-\3 \4:\5:\6/")" +%s)" +%u)" = 7 ]; done
  [ "$(ls daily/*.dump.sha256 | wc -l)" -eq 14 ] && [ "$(ls weekly/*.dump.sha256 | wc -l)" -eq 8 ] || { echo "checksum files do not match the backups"; exit 1; }
  (cd daily && sha256sum -c -s loomcast-*Z.dump.sha256) && (cd weekly && sha256sum -c -s loomcast-*Z.dump.sha256)
  [ -f notes.txt ] && [ -f daily/notes.txt ] && [ -f daily/loomcast-manual.dump ] && [ -f weekly/loomcast-old.dump.bak ] || { echo "rotation touched unrelated files"; exit 1; }
  [ "$(jq -r .at last-success.json)" = "$(date -u -d "@$((BASE + 69 * 86400))" +%Y-%m-%dT%H:%M:%SZ)" ] || { echo "last-success.json is not the last run"; exit 1; }
' || fail "rotation did not keep the configured counts"
pass "exactly 14 daily and 8 weekly backups (the newest days and Sundays), unrelated files untouched"

dr "$VOL_ROT" env PGDATABASE="$SRC_DB" BACKUP_UPLOAD=false BACKUP_NOW=$((base + 70 * 86400)) \
  BACKUP_KEEP_DAILY=3 BACKUP_KEEP_WEEKLY=2 backup.sh once 2>/dev/null
counts=$(dr "$VOL_ROT" sh -c 'echo "$(ls /backups/daily | grep -cE "Z\.dump$") $(ls /backups/weekly | grep -cE "Z\.dump$")"')
[ "$counts" = "3 2" ] || fail "with limits 3 and 2, found daily and weekly counts $counts"
pass "limits 3 daily and 2 weekly are honoured"

next_checks=$(dr "$VOL_ROT" sh -c '
  BACKUP_NOW=1791768600 backup.sh next
  BACKUP_NOW=1791772200 backup.sh next
  BACKUP_NOW=1791775800 BACKUP_AT=23:59 backup.sh next
' | tr '\n' ' ')
[ "$next_checks" = "2026-10-12T02:30:00Z 2026-10-13T02:30:00Z 2026-10-12T23:59:00Z " ] ||
  fail "unexpected next run times: $next_checks"
pass "schedule: next run after 01:30 is 02:30 the same day, after 02:30 the next day"

# --- 7. Encrypted upload and restore from object storage --------------------------------

step "7/7 encrypted upload to a scratch bucket and restore from it"
s3_mode=${DRILL_S3:-auto}
s3_endpoint=${DRILL_S3_ENDPOINT:-$(env_example S3_ENDPOINT)}
if [ "$s3_mode" = 0 ]; then
  echo "skipped (DRILL_S3=0)"
elif ! curl -s -o /dev/null -m 5 "$s3_endpoint/"; then
  [ "$s3_mode" = auto ] || fail "the object store at $s3_endpoint does not answer"
  echo "skipped: the object store at $s3_endpoint does not answer"
else
  s3_hostport=${s3_endpoint#*://}
  s3_hostport=${s3_hostport%%/*}
  s3_host=$(container_host "${s3_hostport%%:*}")
  export BACKUP_S3_ENDPOINT="${s3_endpoint%%://*}://$s3_host:${s3_hostport##*:}"
  export BACKUP_S3_BUCKET=$BUCKET
  export BACKUP_S3_ACCESS_KEY_ID=${S3_ACCESS_KEY:-$(env_example S3_ACCESS_KEY)}
  export BACKUP_S3_SECRET_ACCESS_KEY=${S3_SECRET_KEY:-$(env_example S3_SECRET_KEY)}
  docker volume create "$VOL_S3" >/dev/null

  daws s3api create-bucket --bucket "$BUCKET" >/dev/null
  bucket_created=true
  # A key pair for this run only; the volume holding it is removed on exit.
  recipient=$(dr "$VOL_S3" sh -ec '
    umask 077
    mkdir -p /backups/.drill
    age-keygen -o /backups/.drill/identity.txt 2>/dev/null
    age-keygen -y /backups/.drill/identity.txt
  ')
  sunday=$((base + 6 * 86400))
  dr "$VOL_S3" env PGDATABASE="$SRC_DB" BACKUP_UPLOAD=true BACKUP_AGE_RECIPIENT="$recipient" \
    BACKUP_NOW="$sunday" backup.sh once
  name=$(dr "$VOL_S3" sh -c 'basename "$(jq -r .file /backups/last-success.json)"')
  keys=$(daws s3 ls --recursive "s3://$BUCKET/" | awk '{ print $4 }' | sort | tr '\n' ' ')
  expected_keys="daily/$name.age daily/$name.age.sha256 weekly/$name.age weekly/$name.age.sha256 "
  [ "$keys" = "$expected_keys" ] || fail "bucket holds '$keys', expected '$expected_keys'"
  # head closes the pipe early, so the client's exit status is ignored here.
  header=$(daws s3 cp "s3://$BUCKET/daily/$name.age" - 2>/dev/null | head -c 21 || true)
  [ "$header" = "age-encryption.org/v1" ] || fail "the uploaded object is not an age file"
  dr "$VOL_S3" jq -e '.encrypted == true and (.uploaded | endswith(".dump.age"))' /backups/last-success.json >/dev/null ||
    fail "last-success.json does not record the encrypted upload"
  pass "only the encrypted backup and its checksum were uploaded (daily and weekly)"

  # Restore from the bucket alone: remove the local copies first.
  dr "$VOL_S3" sh -c 'rm -f /backups/daily/* /backups/weekly/*'
  expect_refusal "is encrypted; pass --identity" \
    dr "$VOL_S3" env PGDATABASE="$SRC_DB" restore.sh --target-db "$S3_DB" "daily/$name.age"
  dr "$VOL_S3" env PGDATABASE="$SRC_DB" restore.sh --identity /backups/.drill/identity.txt \
    --target-db "$S3_DB" --compare-with "$SRC_DB" --drop-after "s3://$BUCKET/daily/$name.age"
  dr "$VOL_S3" rm -rf /backups/.drill
  pass "restored from the bucket with the run's identity; row counts match"
fi
