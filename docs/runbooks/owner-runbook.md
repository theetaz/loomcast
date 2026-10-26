# Owner runbook

The owner's procedures for running Loomcast in production: deploys and rollbacks, pausing
publishing, reconnecting channels, restores, a full disk, a lost Mac, and rotating every secret.
When something looks like an attack or a leak, switch to
[incident-response.md](incident-response.md). The security model is in
[../security.md](../security.md).

The host runs other production apps. Everything here touches only the `loomcast` compose project,
`/opt/loomcast` and the Loomcast nginx site. Never run `docker system prune`, `docker volume
prune`, a global `docker compose down`, or an nginx change outside `loomcast.conf`.

## Conventions

Commands marked **server** run on the VPS as root (your usual admin session), from the running
release's directory, with this helper:

```bash
cd /opt/loomcast/current
dc() {
  LOOMCAST_TAG="$(cat /opt/loomcast/state/current)" \
    docker compose -p loomcast -f compose.prod.yml --env-file /opt/loomcast/env/compose.env "$@"
}
```

Env files are `/opt/loomcast/env/{api,postgres,backup,compose}.env` (root, mode 0600). After
editing `api.env`, recreate the api so it reads the file:

```bash
dc up -d --force-recreate --wait api      # server
curl -fsS http://127.0.0.1:"$(grep ^LOOMCAST_HTTP_PORT= /opt/loomcast/env/compose.env | cut -d= -f2)"/readyz
```

Redeploying the running tag from GitHub (*Actions → deploy → Run workflow*) does the same with
the deploy checks and automatic rollback.

Keep secrets out of shell history: edit env files with an editor, and paste secrets at hidden
prompts (`read -rs VAR`) rather than on a command line.

## 1. Deploy and roll back

Details: [deploy.md](deploy.md).

- **Deploy:** merge to `main`. `ci` and `release` run, then a `deploy` run waits for your
  approval in *Actions*. A deploy that fails its health or readiness checks rolls back by itself.
- **Roll back** (preferred): *Actions → deploy → Run workflow* on `main` with tag
  `sha-<12 hex>` of the release to return to, then approve.
- **Roll back** without GitHub (**server**):

  ```bash
  /opt/loomcast/bin/deploy.sh status
  /opt/loomcast/bin/deploy.sh rollback               # to the previous release
  /opt/loomcast/bin/deploy.sh deploy sha-<12 hex>    # or any release by tag
  ```

- Migrations are not rolled back. If the older release cannot read the data, restore instead
  (section 5).
- **The workspaces release** (migrations `0017` and `0018`): deploy the server first, then
  rebuild and restart the studio agent on the Mac; an older agent keeps working against the new
  server meanwhile. Rolling back past it needs a restore. See
  [deploy.md](deploy.md#31-the-workspaces-release-migrations-0017-and-0018).
- **After every deploy**, check the headers from your machine:

  ```bash
  curl -sI https://loomcast.prabhavalabs.com/ | grep -iE 'strict-transport|content-security'
  ```

  Expect `strict-transport-security: max-age=31536000; includeSubDomains` and the web app's
  policy from [../security.md](../security.md#security-headers).

## 2. Pause publishing

Stops every post from going out, in dry-run and live mode alike. Due posts wait and are retried
once publishing is back on.

1. **server:** set `PUBLISHING_ENABLED=false` in `api.env`, then recreate the api.
2. Check: the banner on **Workspace settings → Channels** shows publishing as paused
   (`GET /api/publisher/status` answers `"enabled": false`).
3. To resume: set `PUBLISHING_ENABLED=true`, recreate the api, and review the calendar first.
   Posts that came due while paused publish on the next scheduler ticks.

Pause before a restore from an older backup, while rotating platform app secrets, and as the
first step of any incident involving a channel.

## 3. Switch to dry-run

Two levels; see [../scheduling-and-publishing.md](../scheduling-and-publishing.md#dry-run-and-going-live).

- **One channel** (immediate, no restart): turn the channel's **Dry run** on in its workspace's
  **Workspace settings → Channels**. Posts already queued on it stop going out live.
- **Everything:** **server**, set `PUBLISHING_MODE=dry-run` in `api.env` and recreate the api.
  Every post then records what it would send instead of calling the platforms.

Going back to live is deliberate: `PUBLISHING_MODE=live`, recreate, then turn each channel's
**Dry run** off and type `publish live`. A post keeps the dry-run flag it was created with.

## 4. Reconnect a channel (Meta or Threads reauthorisation)

A token the platform refuses turns the channel `needs_reauth` and raises a `channel.reauth`
alert; its posts fail with an `auth` error.

1. Find out why, if you can: the person who connected it lost their Page role, changed their
   Facebook password, removed the app under *Business integrations*, or a Threads token expired.
2. In the channel's workspace, **Workspace settings → Channels**, the channel's **Reconnect**
   banner, and sign in again with an account that has the Page (or the Threads profile). Accept the
   same Page or profile.
3. Failed posts: retry them from the post or from **Account settings → Scheduler** (dead tasks), or
   reschedule.
4. If every channel of a platform fails at once, check the app itself (**server**):
   `dc exec api node dist/cli/meta-check.mjs`. A failure there means the app ID or secret is
   wrong, the app was restricted, or the Graph version is retired
   ([meta-app-setup.md](meta-app-setup.md)).

## 5. Restore the database

Details and the scratch-restore check: [backup-and-restore.md](backup-and-restore.md).

1. Pause publishing (section 2) if the backup is older than any scheduled post.
2. Restore the backup into a scratch database first and check it.
3. **server:** `dc stop api`, then
   `dc run --rm backup restore.sh --into-production --yes-i-understand /backups/daily/<file>.dump`.
4. `dc up -d --wait api`, check `/readyz`, sign in, look at recent workspaces and the calendar.
5. Resume publishing once the schedule is reviewed. Drop `loomcast_pre_restore_<stamp>` a few
   days later.

Stored channel credentials in the backup are sealed with the encryption key in use when it was
taken. Keep earlier keys until every backup sealed with them has expired (section 8.1).

## 6. Disk full

Symptoms: `/readyz` reports `database: error`, Postgres logs `No space left on device`, the
backup alert fires, or deploys fail to pull.

1. **server:** see what is full, without changing anything:

   ```bash
   df -h / /var/lib/docker
   docker system df
   du -sh /opt/loomcast/backups/* /opt/loomcast/releases 2>/dev/null
   docker image ls 'ghcr.io/theetaz/loomcast*'
   ```

2. Pause publishing (section 2) if Postgres is affected, so no post is half-recorded.
3. Free space **only from Loomcast's own files**:
   - old Loomcast images beyond the last releases:
     `docker image rm ghcr.io/theetaz/loomcast:<old tag>` (the deploy script keeps the current,
     previous and five newest; never prune globally);
   - local backups: lower `BACKUP_KEEP_DAILY` / `BACKUP_KEEP_WEEKLY` in `backup.env` and let the
     next run rotate, or remove the oldest `daily/loomcast-*.dump` and its `.sha256` by hand once
     you have confirmed the off-site copy exists;
   - old release directories under `/opt/loomcast/releases/` that are not `current` or
     `previous`.

   Container logs are capped at 50 MB each and nginx logs are rotated by the host, so they are
   rarely the cause. If other stacks fill the disk, tell their owners; do not delete their data.
4. Once there is room: `dc up -d --wait`, check `/readyz`, check that the next backup succeeds,
   and resume publishing.
5. If the Postgres volume itself is what grew, find the cause before it recurs
   (`dc exec postgres psql -U loomcast -d loomcast -c '\dt+'`) and plan more disk.

## 7. A lost or stolen Mac

The Mac holds a device token (the bridge), possibly MCP tokens, the TTS provider key, a signed-in
browser session and the producer session's own account.

1. **Revoke the device:** **Account settings → Devices → Revoke**. Its bridge connection closes at
   once (4403) and its token stops working. Jobs it was running are handled by the lease reaper, as
   for any lost connection.
2. **Revoke MCP tokens** used on that Mac: **Account settings → Access tokens → Revoke**.
3. **End browser sessions:** if the browser was signed in, reset your password (**server**):
   `dc exec -it api node dist/cli/admin.mjs reset-password --email <you>`. This ends every
   session of the account. Do the same for any member who used the Mac, or disable them in
   **Account settings → Members** (which also revokes the devices they paired).
4. **Rotate the TTS provider key** at the provider and set the new one on the replacement Mac
   (`pnpm agent secrets set voice-provider-key`).
5. **Sign the producer session's account out** of that device from the account's own settings.
6. If the Mac held the deploy key or your server SSH key, rotate them (section 8.8) and remove
   the old public keys from the server.
7. Pair the replacement: create a pairing code on **Account settings → Devices**, then on the new
   Mac `pnpm agent pair --server https://loomcast.prabhavalabs.com --code <code>`.

## 8. Rotating secrets

Rotate on a schedule (yearly, and MCP tokens every 90 days) and at once when a secret may have
leaked. For a leak, revoke first and accept a short outage
([incident-response.md](incident-response.md)).

| Secret | Where it lives | Section |
|---|---|---|
| Encryption key of stored channel credentials | `api.env` `LOOMCAST_ENCRYPTION_KEY*`, password manager | 8.1 |
| Meta and Threads app secrets (and X client secret) | `api.env`, the platforms' developer dashboards | 8.2 |
| R2 keys (app and backups) | `api.env` `S3_*`, `backup.env` | 8.3 |
| Database password | `postgres.env`, `api.env` `DATABASE_URL` | 8.4 |
| MCP tokens | Clients' configuration | 8.5 |
| Device tokens | `~/.config/loomcast-agent/config.json` on the Mac | 8.6 |
| Alert webhook URL, backup age key | `api.env`, `backup.env`, password manager | 8.7 |
| Deploy SSH key | GitHub `production` environment, server `authorized_keys` | 8.8 |

### 8.1 Encryption key (`vault:rotate`)

Values are sealed with the key version that was current when they were written. A rotation adds
a new version, re-seals everything with it, then retires the old one.

1. In your password manager, note the current `LOOMCAST_ENCRYPTION_KEY` and
   `LOOMCAST_ENCRYPTION_KEY_VERSION` (say `1`).
2. Generate the new key on the server: `openssl rand -base64 32`. Store it in the password
   manager as version 2 before using it.
3. **server**, in `api.env`:

   ```
   LOOMCAST_ENCRYPTION_KEY=<new key>
   LOOMCAST_ENCRYPTION_KEY_VERSION=2
   LOOMCAST_ENCRYPTION_KEYS_PREVIOUS=1:<old key>
   ```

4. Recreate the api. Channels keep working: old values open with the previous key.
5. Re-seal and check:

   ```bash
   dc exec api node dist/cli/vault.mjs rotate --dry-run
   dc exec api node dist/cli/vault.mjs rotate
   ```

   It refuses if a row uses a key version that is not configured, and prints no key material.
6. Clear `LOOMCAST_ENCRYPTION_KEYS_PREVIOUS=` and recreate the api. Check a channel page and run
   `meta-check`.
7. Keep the old key in the password manager for 90 days: backups taken before the rotation still
   hold values sealed with it. To use such a backup, restore it, then set the old key as
   `LOOMCAST_ENCRYPTION_KEYS_PREVIOUS` and run `vault rotate`.

If the key leaked, the stored platform tokens must be treated as leaked too: rotate the key as
above, then disconnect and reconnect every channel so the platforms issue new tokens, and reset
the app secrets (8.2).

### 8.2 Meta, Threads and X app secrets

1. Pause publishing (section 2): between resetting a secret and the api using the new one,
   platform calls fail.
2. Meta: *App dashboard → App settings → Basic → App secret → Reset*. Threads: the Threads app's
   *Settings → Basic*. X (only with `FEATURE_X_PUBLISHING`): the developer portal's *Keys and
   tokens → OAuth 2.0 client secret → Regenerate*.
3. **server:** update `META_APP_SECRET`, `THREADS_APP_SECRET` or `X_CLIENT_SECRET` in `api.env`,
   recreate the api, then `dc exec api node dist/cli/meta-check.mjs` (exit code 0).
4. Open each workspace's **Workspace settings → Channels**: reconnect any channel that turns
   `needs_reauth`.
5. Resume publishing.

### 8.3 R2 keys

Follow [r2.md](r2.md#rotating-or-revoking-a-key) for the app token (`S3_ACCESS_KEY`,
`S3_SECRET_KEY` in `api.env`) and [backup-and-restore.md](backup-and-restore.md) for the backups
token in `backup.env`:

1. Create a new token with the same permissions and bucket scope.
2. Put the keys in the env file, then `dc up -d --force-recreate --wait api` (or `backup`).
3. Check: `/readyz` shows `storage: ok`; for backups, `dc exec backup backup.sh once` or the next
   nightly run, and `last-success.json`.
4. Delete the old token in the Cloudflare dashboard.

Presigned URLs already handed out stop working when their token is deleted; uploads in progress
are retried by the web app or the studio agent.

### 8.4 Database password

`POSTGRES_PASSWORD` in `postgres.env` is only read when the volume is first created, but the
backup service reads it on every run, so both files change together.

1. Generate it: `openssl rand -hex 32` (hex needs no escaping in a URL).
2. **server**, at a psql prompt so the password stays out of history and `ps`:

   ```bash
   dc exec -it postgres psql -U loomcast -d postgres
   loomcast=# \password loomcast
   ```

   Connections already open stay up; new ones need the new password.
3. Update `POSTGRES_PASSWORD` in `postgres.env` and the password inside `DATABASE_URL` in
   `api.env`.
4. `dc up -d --force-recreate --wait api backup`, check `/readyz` and run a backup once.

### 8.5 MCP tokens

1. **Account settings → Access tokens → Create**, with the same scopes and an expiry (90 days). Or
   on the **server**: `dc exec -it api node dist/cli/admin.mjs token --email <you> --name <name>
   --scopes mcp:read,mcp:write`.
2. Put the new token in the client's configuration.
3. Revoke the old token on the same page. Its next request gets 401.

Job tokens need no rotation: each lives for one job and is revoked when the job ends.

### 8.6 Device tokens

There is no in-place rotation: revoke and pair again.

1. Create a pairing code on **Account settings → Devices**.
2. On the Mac: `pnpm agent pair --server https://loomcast.prabhavalabs.com --code <code>`; the
   new token replaces the old one in the agent's config.
3. Revoke the old device entry on **Account settings → Devices**, then restart the agent so it
   connects with the new token (stop and start `pnpm agent run`, or `pnpm agent service install`
   again for the launchd service). Check that **Account settings → Devices** shows it online.

### 8.7 Alert webhook and backup key

- **Alert webhook:** create a new ntfy topic, Slack or Discord hook, set `ALERT_WEBHOOK_URL` in
  both `api.env` and `backup.env`, recreate both services, test it as in
  [monitoring.md](monitoring.md#testing-the-webhook), then delete the old hook.
- **Backup age key:** generate a new key pair off the server, put the public key in
  `BACKUP_AGE_RECIPIENT`, recreate `backup`. Keep the old identity for as long as backups
  encrypted to it exist in the bucket (90 days).

### 8.8 Deploy SSH key

Follow [deploy.md](deploy.md#6-rotating-the-deploy-key): add the new public key as a second line
in `authorized_keys`, replace `VPS_SSH_KEY` in the GitHub `production` environment, run a deploy
or `status`, then remove the old line. For a leaked key, remove the old line first.

## 9. Routine checks

- Daily: alerts, if any. Weekly: `/api/ops/status` (backup age, dead tasks), the `ci` audit job.
- Monthly: scratch-restore the latest backup ([backup-and-restore.md](backup-and-restore.md#the-drill)).
- Quarterly: review **Account settings → Members**, **Access tokens** and **Devices** and revoke
  what is no longer used; restore from the bucket with the age identity.
