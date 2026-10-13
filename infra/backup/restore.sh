#!/usr/bin/env bash
# Restores a Loomcast backup.
#
#   restore.sh [options] <file | s3-key>
#
# By default the backup goes into a new scratch database (loomcast_restore_<UTC stamp>) on the
# same server, and the row count of every table is printed. Production is not touched.
#
#   <file>     a local backup, for example /backups/daily/loomcast-20261012T023000Z.dump
#   <s3-key>   a key in BACKUP_S3_BUCKET, for example daily/loomcast-20261012T023000Z.dump.age,
#              or a full s3://bucket/key
#
# Options:
#   --target-db NAME     name of the scratch database to create (it must not exist yet)
#   --identity FILE      age identity file for .age backups (default: BACKUP_AGE_IDENTITY_FILE)
#   --compare-with NAME  compare the restored row counts with database NAME; fail on differences
#   --drop-after         drop the scratch database once the checks pass
#   --skip-checksum      restore even when there is no .sha256 file next to the backup
#   --into-production --yes-i-understand
#                        replace the production database (PGDATABASE or POSTGRES_DB). Stop the
#                        api first: the script refuses while anything else is connected. The
#                        backup is restored into a new database and checked, then the databases
#                        are swapped by renaming; the old one is kept as <name>_pre_restore_<stamp>.
#
# A checksum mismatch, an unreadable archive or any restore error stops the script before
# anything is swapped.
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

IDENT_RE='^[a-z_][a-z0-9_]{0,62}$'
MAINTENANCE_DB=${BACKUP_MAINTENANCE_DB:-postgres}

target_db=
identity=${BACKUP_AGE_IDENTITY_FILE:-}
compare_with=
drop_after=false
skip_checksum=false
into_production=false
confirmed=false
source_arg=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-db)
      target_db=${2:?--target-db needs a name}
      shift 2
      ;;
    --identity)
      identity=${2:?--identity needs a file}
      shift 2
      ;;
    --compare-with)
      compare_with=${2:?--compare-with needs a database name}
      shift 2
      ;;
    --drop-after)
      drop_after=true
      shift
      ;;
    --skip-checksum)
      skip_checksum=true
      shift
      ;;
    --into-production)
      into_production=true
      shift
      ;;
    --yes-i-understand)
      confirmed=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      die "unknown option $1"
      ;;
    *)
      [ -z "$source_arg" ] || die "only one backup can be restored at a time"
      source_arg=$1
      shift
      ;;
  esac
done

[ -n "$source_arg" ] || {
  usage >&2
  exit 2
}

pg_env
production_db=$PGDATABASE
stamp=$(date -u +%Y%m%dT%H%M%SZ)
lower_stamp=$(printf '%s' "$stamp" | tr '[:upper:]' '[:lower:]')

if [ "$into_production" = true ]; then
  [ "$confirmed" = true ] || die "--into-production also needs --yes-i-understand"
  [ -z "$target_db" ] || die "--target-db cannot be combined with --into-production"
  [ "$drop_after" = false ] || die "--drop-after cannot be combined with --into-production"
  [[ $production_db =~ $IDENT_RE ]] || die "unexpected production database name '$production_db'"
  target_db=${production_db}_incoming_$lower_stamp
else
  target_db=${target_db:-loomcast_restore_$lower_stamp}
  [ "$target_db" != "$production_db" ] || die "refusing to restore over '$production_db'; use --into-production"
fi
[[ $target_db =~ $IDENT_RE ]] || die "database names must match $IDENT_RE (got '$target_db')"
if [ -n "$compare_with" ]; then
  [[ $compare_with =~ $IDENT_RE ]] || die "database names must match $IDENT_RE (got '$compare_with')"
fi

psql_on() {
  local db=$1
  shift
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -At -d "$db" "$@"
}

database_exists() {
  [ "$(psql_on "$MAINTENANCE_DB" -c "select count(*) from pg_database where datname = '$1'")" = 1 ]
}

# Sessions on database $1 other than this script's.
other_sessions() {
  psql_on "$MAINTENANCE_DB" -c "select count(*) from pg_stat_activity where datname = '$1' and pid <> pg_backend_pid()"
}

require_no_sessions() {
  local count
  count=$(other_sessions "$1")
  [ "$count" = 0 ] || die "$count other session(s) are connected to '$1'. Stop the api first:
  docker compose -p loomcast -f compose.prod.yml --env-file /opt/loomcast/env/compose.env stop api"
}

# Prints "schema.table<TAB>rows" for every table, sorted.
table_counts() {
  psql_on "$1" -F "$(printf '\t')" <<'SQL'
select format('%I.%I', n.nspname, c.relname),
       (xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname),
                           false, true, '')))[1]::text::bigint
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg\_toast%'
  and n.nspname not like 'pg\_temp%'
order by 1;
SQL
}

check_backup_dir
work=$(mktemp -d "$BACKUP_DIR/.restore.XXXXXX")
created_db=
finished=false

cleanup() {
  case "$work" in
    "$BACKUP_DIR"/.restore.*) rm -rf -- "$work" ;;
  esac
  if [ "$finished" = false ] && [ -n "$created_db" ]; then
    log "dropping the incomplete database '$created_db'"
    psql_on "$MAINTENANCE_DB" -c "drop database if exists \"$created_db\"" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 1. Fetch the backup and its checksum.
if [ -f "$source_arg" ]; then
  file=$source_arg
  checksum_file=$source_arg.sha256
else
  case "$source_arg" in
    s3://*/?*)
      rest=${source_arg#s3://}
      BACKUP_S3_BUCKET=${rest%%/*}
      key=${rest#*/}
      ;;
    s3://*) die "no object key in $source_arg" ;;
    /* | ./* | ../*) die "no such file: $source_arg" ;;
    *) key=$source_arg ;;
  esac
  s3_env
  file=$work/${key##*/}
  checksum_file=$file.sha256
  log "downloading s3://$BACKUP_S3_BUCKET/$key"
  s3 s3 cp --only-show-errors --no-progress "s3://$BACKUP_S3_BUCKET/$key" "$file" ||
    die "download of $key failed"
  s3 s3 cp --only-show-errors "s3://$BACKUP_S3_BUCKET/$key.sha256" "$checksum_file" 2>/dev/null ||
    rm -f -- "$checksum_file"
fi

# 2. Verify the checksum of exactly what was stored.
if [ -f "$checksum_file" ]; then
  expected=$(cut -d' ' -f1 <"$checksum_file")
  actual=$(sha256sum "$file" | cut -d' ' -f1)
  [ "$expected" = "$actual" ] || die "checksum mismatch for ${file##*/}: expected $expected, got $actual"
  log "checksum verified: $actual"
elif [ "$skip_checksum" = true ]; then
  log "warning: no checksum file for ${file##*/}; continuing because of --skip-checksum"
else
  die "no checksum file ${checksum_file##*/}; pass --skip-checksum to restore anyway"
fi

# 3. Decrypt.
case "$file" in
  *.age)
    [ -n "$identity" ] || die "${file##*/} is encrypted; pass --identity or set BACKUP_AGE_IDENTITY_FILE"
    [ -r "$identity" ] || die "cannot read the age identity file $identity"
    plain=$work/$(basename "$file" .age)
    age --decrypt --identity "$identity" --output "$plain" "$file" || die "age could not decrypt ${file##*/}"
    file=$plain
    log "decrypted ${file##*/}"
    ;;
esac
pg_restore --list "$file" >/dev/null || die "${file##*/} is not a readable pg_dump archive"

# 4. Restore into a new database.
if [ "$into_production" = true ]; then
  database_exists "$production_db" || die "production database '$production_db' does not exist"
  # Keeps the scheduled backup from connecting in the middle of the swap.
  exec 9>"$BACKUP_DIR/.lock"
  flock -n 9 || die "a backup is running right now; try again when it has finished"
  require_no_sessions "$production_db"
fi
! database_exists "$target_db" || die "database '$target_db' already exists"
log "creating database '$target_db'"
psql_on "$MAINTENANCE_DB" -c "create database \"$target_db\" template template0" >/dev/null
created_db=$target_db
log "restoring ${file##*/} into '$target_db'"
pg_restore --exit-on-error --single-transaction --no-owner --dbname="$target_db" "$file" ||
  die "pg_restore failed; '$target_db' will be dropped"

# 5. Sanity counts.
counts=$(table_counts "$target_db")
tables=$(printf '%s\n' "$counts" | grep -c . || true)
rows=$(printf '%s\n' "$counts" | awk -F '\t' '{ total += $2 } END { print total + 0 }')
[ "$tables" -gt 0 ] || die "the restored database has no tables"
printf '%s\n' "$counts" | awk -F '\t' '{ printf "%12s  %s\n", $2, $1 }'
log "restored $tables tables with $rows rows into '$target_db'"

if [ -n "$compare_with" ]; then
  expected_counts=$(table_counts "$compare_with")
  if [ "$counts" != "$expected_counts" ]; then
    diff <(printf '%s\n' "$expected_counts") <(printf '%s\n' "$counts") >&2 || true
    die "row counts differ from '$compare_with' (lines starting with < are $compare_with)"
  fi
  log "row counts match '$compare_with' for all $tables tables"
fi

# 6. Swap into production, or keep or drop the scratch database.
if [ "$into_production" = true ]; then
  previous=${production_db}_pre_restore_$lower_stamp
  require_no_sessions "$production_db"
  psql_on "$MAINTENANCE_DB" --single-transaction >/dev/null <<SQL
alter database "$production_db" rename to "$previous";
alter database "$target_db" rename to "$production_db";
SQL
  finished=true
  log "production database '$production_db' replaced; the previous one is kept as '$previous'"
  log "start the api again, check the app, then drop '$previous' when it is no longer needed"
elif [ "$drop_after" = true ]; then
  psql_on "$MAINTENANCE_DB" -c "drop database \"$target_db\"" >/dev/null
  finished=true
  log "dropped '$target_db'"
else
  finished=true
  log "kept '$target_db'; drop it when done: drop database \"$target_db\";"
fi
