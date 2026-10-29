# Backup, restore and drill

The `backup` service in `infra/compose/compose.prod.yml` takes a nightly dump of the Loomcast
database, keeps rotated copies on the server, and uploads an encrypted copy to the private
`loomcast-backups` bucket on Cloudflare R2. `restore.sh` restores a backup into a scratch
database or, deliberately, into production. `infra/backup/test/drill.sh` proves the whole cycle
on a development machine.

Steps marked **Owner checkpoint** need the owner: they create credentials or keys that never go
into git.

## What runs where

| Item | Where | Notes |
|---|---|---|
| Image | `ghcr.io/theetaz/loomcast-backup:<tag>` | Built from `infra/backup/` on `postgres:18-alpine`, the major version of the host's shared Postgres (`platform-postgres`), so `pg_dump` is never older than the server. Adds the S3 command line client, `age`, `jq` and `curl`. Runs as uid 70. |
| Service | `backup` in the `loomcast` compose project | 128 MiB memory cap (no swap), half a CPU, 64 processes, read-only root filesystem, 32 MiB `/tmp`, no capabilities, `no-new-privileges`. Networks: `backend` (postgres) and `egress` (R2 and the alert webhook). |
| Local backups | `/opt/loomcast/backups` on the host, `/backups` in the container | `daily/` and `weekly/` hold `loomcast-<UTC stamp>.dump` plus `.sha256`; `last-success.json` and `last-failure.json` describe the latest run. |
| Off-site copies | `s3://loomcast-backups/daily/` and `weekly/` | `loomcast-<stamp>.dump.age` plus `.age.sha256`. Removed after 90 days by the bucket's lifecycle rule, never by the script. |
| Settings | `/opt/loomcast/env/backup.env` (mode 0600) | Template: `infra/compose/env/backup.env.example`. The database user, name and password come from `postgres.env`, which the service also reads. |

The release pipeline publishes the image with the same tag as the app image. To build it by
hand from a checkout: `docker build -t ghcr.io/theetaz/loomcast-backup:<tag> infra/backup`.

The service only connects to this project's `postgres` service, only writes inside
`/opt/loomcast/backups` and the backups bucket, and only deletes files in `daily/` and
`weekly/` whose names match `loomcast-<YYYYMMDD>T<HHMMSS>Z.dump` (and their `.sha256`). It has
no Docker socket and cannot touch other stacks on the host.

## How a backup runs

1. `backup.sh run` (the container's command) sleeps until `BACKUP_AT` (UTC) and wakes at least
   every five minutes to re-check the clock.
2. `pg_dump --format=custom --compress=6` writes `daily/loomcast-<stamp>.dump.tmp`. The archive
   is checked with `pg_restore --list`, renamed, and given a `.sha256` file.
3. On `BACKUP_WEEKLY_DAY` (Sunday by default) the first backup of the day is also kept in
   `weekly/` (a hard link, so it costs no extra space).
4. Rotation keeps the newest `BACKUP_KEEP_DAILY` (14) daily and `BACKUP_KEEP_WEEKLY` (8)
   weekly backups.
5. With uploads on, the backup is encrypted with `age` to `BACKUP_AGE_RECIPIENT`, uploaded with
   its checksum to `daily/` (and copied to `weekly/` on the weekly day), and the stored size is
   read back.
6. `last-success.json` is written:

   ```json
   {"at": "2026-10-12T02:30:00Z", "bytes": 1048576, "sha256": "…", "file": "daily/loomcast-20261012T023000Z.dump",
    "weekly": false, "uploaded": "daily/loomcast-20261012T023000Z.dump.age", "encrypted": true, "durationSeconds": 4}
   ```

   Any failure (database, disk, encryption, upload) instead writes `last-failure.json`
   (`{at, error}`) and posts to `ALERT_WEBHOOK_URL` when it is set. The schedule carries on and
   the next run is the next day. The api's ops status reads `last-success.json` and raises an
   alert when it is older than 26 hours.

Only one backup runs at a time (a lock file in `/backups`); a second one fails at once.

## Settings (`backup.env`)

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_AT` | `02:30` | Daily run time, `HH:MM` UTC |
| `BACKUP_KEEP_DAILY` | `14` | Daily backups kept on the server |
| `BACKUP_KEEP_WEEKLY` | `8` | Weekly backups kept on the server |
| `BACKUP_WEEKLY_DAY` | `7` | ISO weekday of the weekly copy (1 Monday … 7 Sunday) |
| `BACKUP_UPLOAD` | `auto` (template: `true`) | `true`: upload, and fail the run if the upload fails. `false`: server only. `auto`: upload when `BACKUP_S3_ENDPOINT` is set |
| `BACKUP_S3_ENDPOINT` | — | `https://<account id>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET` | `loomcast-backups` | Bucket for off-site copies |
| `BACKUP_S3_REGION` | `auto` | Region for request signing (R2 uses `auto`) |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | — | The scoped backups token (secret) |
| `BACKUP_AGE_RECIPIENT` | — | age public key(s), comma-separated. Empty uploads unencrypted (a warning is logged) |
| `ALERT_WEBHOOK_URL` | — | Called on a failed backup (secret) |
| `ALERT_WEBHOOK_FORMAT` | `json` | `json` (`{source, key: "backup.failed", level, title, message, at}`), `ntfy` or `slack` |

`PGHOST`, `PGPORT` and `BACKUP_DIR` are fixed in `compose.prod.yml`. Restores also read
`BACKUP_AGE_IDENTITY_FILE` (path of the age identity inside the container) when it is set.

## One-time setup

### 1. Owner checkpoint: the backups bucket and its token

Follow the R2 runbook to create the private `loomcast-backups` bucket with a 90-day lifecycle
rule. Then create an R2 API token with **Object Read & Write** on **that bucket only** (not the
media buckets, no admin rights). Note the access key ID, the secret access key and the account's
S3 endpoint. Read access is needed for restores and for the size check after each upload; the
token never needs delete rights because the lifecycle rule expires old objects.

### 2. Owner checkpoint: the age key pair

Generate the key pair on your own machine, never on the server:

```bash
age-keygen -o loomcast-backup-identity.txt
# or, without age installed:
docker run --rm --entrypoint age-keygen ghcr.io/theetaz/loomcast-backup:<tag>
```

Store the whole identity file (it starts with `AGE-SECRET-KEY-`) in the password manager, and
consider a second copy offline. Without it the off-site backups cannot be decrypted. Only the
public key (`age1…`, printed as "Public key") goes on the server. To allow a second person or a
recovery key, list several public keys separated by commas.

### 3. The server

As root on the server:

```bash
install -d -o 70 -g 70 -m 0711 /opt/loomcast/backups
cp backup.env.example /opt/loomcast/env/backup.env     # from the release directory's env/
chmod 0600 /opt/loomcast/env/backup.env
```

Fill in `backup.env`: the endpoint, the token from step 1 and the public key from step 2. Leave
`BACKUP_UPLOAD=true`. Mode `0711` on the directory lets the api (a different user) read
`last-success.json` by name without being able to list the backups; the dumps themselves are
`0600`. compose does not create the directory: the service fails to start until it exists,
rather than writing into a root-owned directory.

To keep the backups somewhere else (a separate disk), set `LOOMCAST_BACKUP_DIR` in
`compose.env`.

### 4. Start and take the first backup

```bash
cd /opt/loomcast/releases/<tag>
dc() { docker compose -p loomcast -f compose.prod.yml --env-file /opt/loomcast/env/compose.env "$@"; }

dc up -d backup
dc run --rm backup backup.sh once          # a backup now, without waiting for the schedule
cat /opt/loomcast/backups/last-success.json
dc logs --tail=50 backup                   # "next backup at …"
```

Then run a scratch restore of that backup (below) to prove the token and the key work end to
end, including a restore from the bucket with the identity file.

## Daily checks and troubleshooting

```bash
cat /opt/loomcast/backups/last-success.json
cat /opt/loomcast/backups/last-failure.json 2>/dev/null   # present only after a failure
ls -l /opt/loomcast/backups/daily /opt/loomcast/backups/weekly
dc logs --since 24h backup
dc run --rm backup backup.sh next          # when the next scheduled backup runs
df -h /opt/loomcast/backups
```

| Symptom | Likely cause | Fix |
|---|---|---|
| `pg_dump failed: … password authentication failed` | `postgres.env` and the database disagree | Update the password in `postgres.env` (see the compose README) |
| `BACKUP_DIR '/backups' is not writable by uid 70` | Directory owner | `chown 70:70 /opt/loomcast/backups` |
| `upload of … failed`, `could not read back …` | Token, endpoint or bucket wrong, or R2 unreachable | Check `backup.env`; the local backup is kept, rerun `backup.sh once` |
| `another backup is running` | A manual run overlapped the schedule | Wait for it; nothing to fix |
| Container restarts with exit 137 | Memory cap | Check `dc logs backup`; the upload concurrency is already low, so report it |

## Restore

`restore.sh` takes a local file or an object key. It verifies the `.sha256` file stored next to
the backup, decrypts `.age` files with an identity given at restore time, checks the archive and
restores it with `pg_restore --single-transaction --exit-on-error` into a **new** database.
It then prints the row count of every table. It never writes over an existing database.

Options: `--target-db NAME`, `--identity FILE`, `--compare-with NAME` (fail when row counts
differ), `--drop-after`, `--skip-checksum` (only when a checksum file is genuinely lost), and
`--into-production --yes-i-understand`. `restore.sh --help` prints the details.

### Check a backup (scratch restore, safe at any time)

```bash
dc run --rm backup restore.sh --drop-after /backups/daily/loomcast-20261012T023000Z.dump
```

Without `--drop-after` the scratch database (`loomcast_restore_<stamp>`) is kept for
inspection. Drop it when done:

```bash
docker exec platform-postgres psql -U postgres -c "drop database loomcast_restore_<stamp>"
```

A scratch restore needs free disk space for a second copy of the database and runs inside the
host's shared Postgres, so do it outside the backup window. Restores create and rename databases,
so the `loomcast` role has `CREATEDB` on the shared server (`alter role loomcast createdb`).

### Restore from the bucket (encrypted copy)

Use this when the server's own copies are gone. Copy the identity file to the server only for
the restore, readable by uid 70, mount it read-only, and remove it afterwards:

```bash
install -m 0400 -o 70 -g 70 loomcast-backup-identity.txt /root/loomcast-restore-identity.txt
dc run --rm -v /root/loomcast-restore-identity.txt:/run/age-identity:ro backup \
  restore.sh --identity /run/age-identity daily/loomcast-20261012T023000Z.dump.age
shred -u /root/loomcast-restore-identity.txt
```

To list the keys with the service's own token:

```bash
dc run --rm backup sh -c 'AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
  aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 ls "s3://$BACKUP_S3_BUCKET/daily/"'
```

A full `s3://loomcast-backups/<key>` works as the argument too.

### Restore into production

This replaces the live database. Do it only after a scratch restore of the same backup looks
right.

1. **Pause publishing** if the backup is older than any scheduled post: set
   `PUBLISHING_ENABLED=false` in `api.env`, otherwise posts already published since the backup
   may be published again.
2. **Stop the api:** `dc stop api`. The script refuses while any other session is connected to
   the production database; it cannot stop the api itself because the backup container has no
   access to Docker.
3. **Restore:**

   ```bash
   dc run --rm backup restore.sh --into-production --yes-i-understand \
     /backups/daily/loomcast-20261012T023000Z.dump
   ```

   For a bucket key, add the identity mount from the previous section. The script restores
   into `loomcast_incoming_<stamp>`, checks it, and then, in one transaction, renames the live
   database to `loomcast_pre_restore_<stamp>` and the new one to `loomcast`. It holds the backup
   lock so the scheduled backup cannot connect in the middle. If anything fails before the
   swap, the incoming database is dropped and production is unchanged.
4. **Start the api:** `dc up -d --wait api`. Pending migrations from a newer release apply on
   start. Check `/readyz`, sign in and look at recent workspaces.
5. **Re-enable publishing** when the schedule has been reviewed.
6. **Clean up** a few days later: drop `loomcast_pre_restore_<stamp>` (as in the scratch
   example).

Rollback, while `loomcast_pre_restore_<stamp>` still exists:

```bash
dc stop api
docker exec platform-postgres psql -U postgres -1 \
  -c "alter database loomcast rename to loomcast_failed_restore" \
  -c "alter database loomcast_pre_restore_<stamp> rename to loomcast"
dc up -d --wait api
```

### A new server

Set up the host's shared Postgres (`/opt/platform`), the env files and the backup directory as
above. Create the role and an empty database with `/opt/platform/bin/pg-new-app.sh loomcast`,
then `alter role loomcast createdb` and `create extension pg_trgm` in it as the platform
superuser. Restore with `--into-production --yes-i-understand` (the empty database is kept as
`loomcast_pre_restore_<stamp>`; drop it), then `dc up -d --wait`.

## The drill

`infra/backup/test/drill.sh` runs against the local development stack only:

```bash
pnpm stack:up
bash infra/backup/test/drill.sh
```

It builds the image under a throwaway tag and runs each step in it with the production limits
(128 MiB, read-only root filesystem, no capabilities, uid 70):

1. creates and seeds a scratch database `loomcast_drill_<id>` next to the dev database;
2. backs it up and checks the checksum and `last-success.json`;
3. restores into a second scratch database and compares row counts and a data fingerprint;
4. checks that a wrong checksum, a restore over the source and an unconfirmed
   `--into-production` are refused;
5. runs `--into-production` against the scratch database standing in for production: refused
   while a session is open, then swapped, with the old copy kept;
6. runs 70 backups with fake dates (`BACKUP_NOW`) and checks that exactly 14 daily and 8 weekly
   backups remain (the newest days and the newest Sundays), that unrelated files survive, that
   smaller limits are honoured, and the next-run calculation;
7. when the local object store (`S3_ENDPOINT` in `.env.example`) answers: generates an age key
   for the run, uploads to a scratch bucket, checks that only `.age` objects were stored, and
   restores from the bucket.

Everything it creates (databases, volumes, bucket, key, image) is removed on exit, also on
failure. The `loomcast` dev database and the stack's containers are never changed.
`DRILL_S3=0` skips step 7, `DRILL_S3=1` makes it mandatory, and `DRILL_IMAGE=<tag>` tests an
already built image (for example a release image).

On the server, the equivalent is a monthly scratch restore of the latest backup and, each
quarter, a restore from the bucket with the identity file. Record the date and the row counts.

## Owner checkpoints

- [ ] R2: private `loomcast-backups` bucket with a 90-day lifecycle rule.
- [ ] R2: API token with Object Read & Write on `loomcast-backups` only; values in
  `/opt/loomcast/env/backup.env`.
- [ ] age key pair generated off the server; identity in the password manager; public key in
  `BACKUP_AGE_RECIPIENT`.
- [ ] `/opt/loomcast/backups` created with owner 70 and mode 0711.
- [ ] First backup taken, and a scratch restore from the bucket done with the identity file.
- [ ] Optional: `ALERT_WEBHOOK_URL` set for backup failures.
