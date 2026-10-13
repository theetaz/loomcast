# Monitoring, logs and alerting

How Loomcast reports its health, where its logs go and how they are rotated, and how alerts
reach the owner. Owner checkpoint **C10** (the alert webhook) and the go-live switch for the
uptime check are listed at the end.

The server runs other production applications. Every command below is scoped to the compose
project `loomcast` or to Loomcast's own files. Nothing here changes Docker, nginx or logrotate
settings for the rest of the host.

## What watches what

| Signal | Answers | Used by |
|---|---|---|
| `GET /healthz` | 200 while the process serves requests (liveness only) | The container healthcheck in `compose.prod.yml` |
| `GET /readyz` | 200 or 503 from the readiness checks below, each bounded to 2 s | `deploy.sh` (rolls back when it stays red), the deploy workflow, the uptime workflow |
| `GET /api/ops/status` | Owner only: version, commit, uptime, check details, scheduler, last backup | The owner, by hand |
| Alerts | A webhook call per problem, at most once an hour per alert key | Dead or failed scheduled tasks, failed publishes, channels that need reauthorisation, stale backups |
| Uptime workflow | An `incident` issue while `/readyz` is red from outside | GitHub notifications |
| Backup service | `last-success.json`, `last-failure.json` and its own failure alert | The api's backup monitor, `backup-and-restore.md` |

`/healthz` stays green when a dependency fails, so Docker does not restart a healthy process
because the database or object storage is having a bad minute. Readiness is what deploys and
the uptime check look at.

## Readiness checks

`/readyz` runs every check at once and answers with statuses only:

```json
{"status": "ok", "checks": {"database": "ok", "storage": "ok", "scheduler": "ok"}}
```

| Check | Green when | Red when | `skipped` when |
|---|---|---|---|
| `database` | `select 1` succeeds within 2 s | Postgres is down, the pool is exhausted or the query is slow | never |
| `storage` | HEAD on the private bucket (`S3_BUCKET`) succeeds | The endpoint is unreachable, the token is refused or the bucket is missing | No S3 settings outside production (production requires them) |
| `scheduler` | The task loop ticked recently | The loop is `stalled`: no good tick for six intervals (at least a minute) | `SCHEDULER_ENABLED=false`, or the loop does not run in this process |

The storage result is reused for 60 s when it is good and for 10 s when it failed, so probes
cost at most one bucket request a minute and recovery still shows quickly. During shutdown every
check is `skipped` and the answer is 503, so the proxy and the deploy script stop sending traffic
before the process exits. Error details never appear in the public answer; they are logged as
`readiness check failed` and shown on the ops status.

Modules that own another dependency register their own check with `deps.health.register` (see
`apps/api/README.md`); it then appears in `/readyz` under its name.

Check it on the server, or from outside:

```bash
curl -sS http://127.0.0.1:"$LOOMCAST_HTTP_PORT"/readyz; echo
curl -sS https://loomcast.prabhavalabs.com/readyz; echo
/opt/loomcast/bin/deploy.sh status   # also prints "readyz: ok" or "readyz: failing"
```

## Ops status

`GET /api/ops/status` needs a signed-in owner session. Open
`https://loomcast.prabhavalabs.com/api/ops/status` in the browser where the owner is signed in.
It answers with:

| Field | Content |
|---|---|
| `version`, `gitSha` | Package version and the commit the image was built from (`LOOMCAST_GIT_SHA`) |
| `environment`, `startedAt`, `uptimeSeconds`, `checkedAt` | The process |
| `readiness` | Every check with its status, detail and duration |
| `scheduler` | `status`, `lastTickAt`, `lastTickError`, `inFlight`, registered task kinds and `queueDepths` per task status |
| `backup` | `status` (`ok`, `stale`, `missing`, `unreadable`, `not_configured`), `lastSuccessAt`, `ageHours`, `file`, `bytes`, `uploaded`, `encrypted`, and the last failure when it is newer than the last success |
| `alerts` | Whether a webhook is configured, and its format |

A `dead` count in `scheduler.queueDepths` means tasks gave up; list them with
`GET /api/scheduler/tasks?status=dead` and retry one with `POST /api/scheduler/tasks/:id/retry`.

### The backup monitor

`compose.prod.yml` mounts `LOOMCAST_BACKUP_DIR` (default `/opt/loomcast/backups`) read-only into
the api at `/backups` and sets `BACKUP_DIR=/backups`. The directory is mode 0711, owner uid 70,
so the api (uid 1000) can open `last-success.json` and `last-failure.json` by name but cannot
list the directory or read a dump. The api reads the status at start, every hour, and on each
ops status request. It alerts:

- `backup.stale` when the last success is older than **26 hours** (a missed nightly run), or
  when no backup exists 26 hours after the api started (a fresh install gets a day for its
  first backup);
- `backup.unreadable` when the file cannot be read or parsed (the mount or the permissions).

A failed backup run is alerted by the backup service itself, straight away. The api's alert
covers the case the service cannot report: it did not run at all.

## Alerts

### Settings

In `/opt/loomcast/env/api.env` (and the same values in `backup.env`, so backup failures go to
the same place):

| Variable | Value |
|---|---|
| `ALERT_WEBHOOK_URL` | The webhook URL. It is a secret: it carries the topic or the hook's key. Empty means alerts are only logged |
| `ALERT_WEBHOOK_FORMAT` | `json` (default), `ntfy` or `slack` |

Restart the api after a change (`deploy.sh` does on the next deploy; by hand, see
[deploy.md](deploy.md#5-status-logs-and-files)).

| Format | Request | Works with |
|---|---|---|
| `json` | `POST` with `{"source":"loomcast-api","key","level","title","message","data","at"}` | Any receiver that accepts JSON: a small relay, a monitoring service's generic webhook |
| `ntfy` | `POST` of the message as plain text with `Title`, `Priority: high` and `Tags: loomcast,<kind>` headers | ntfy.sh or a self-hosted ntfy server; the topic in the URL is the secret, so make it long and random |
| `slack` | `POST` of `{"text": "*title*\nmessage"}` | Slack incoming webhooks; Discord webhooks with `/slack` appended to their URL |

### Behaviour

- Every alert is logged at error level with its key, whether or not a webhook is configured,
  so the logs always have the full record.
- An alert key is sent at most **once an hour** per api process; repeats inside the hour are
  dropped (logged at debug level). A delivery that fails is not counted, so the next occurrence
  tries again. The window resets when the api restarts.
- A webhook call times out after 10 s and never blocks or fails the work that raised it.
- The URL never appears in a log line, an error message or the ops status.

| Key | Raised by | Means |
|---|---|---|
| `task.dead:<taskId>` | Scheduler | A scheduled task used up its attempts. Retry it after fixing the cause |
| `task.failed:<taskId>` | Scheduler | A scheduled task failed permanently on its first error |
| `post.failed:<postId>` | Publisher | A post could not be published |
| `channel.reauth:<channelId>` | Channels, once reauthorisation checks ship | A channel's credentials expired or were revoked; reconnect it |
| `backup.stale` | Backup monitor | No successful backup in 26 hours |
| `backup.unreadable` | Backup monitor | The api cannot read the backup status file |
| `backup.failed` | Backup service | The nightly run failed (sent by `backup.sh`, not de-duplicated) |

### Testing the webhook

Send one message by hand from your own machine with the same shape the api uses, then check it
arrives (replace the placeholder with the real URL; do not paste it into shared notes):

```bash
url='<ALERT_WEBHOOK_URL>'
# json
curl -fsS -H 'Content-Type: application/json' \
  -d '{"source":"loomcast-api","key":"test","level":"error","title":"Loomcast test alert","message":"Webhook works.","data":{},"at":"2026-01-01T00:00:00Z"}' "$url"
# ntfy
curl -fsS -H 'Title: Loomcast test alert' -H 'Priority: high' -H 'Tags: loomcast,test' -d 'Webhook works.' "$url"
# slack
curl -fsS -H 'Content-Type: application/json' -d '{"text":"*Loomcast test alert*\nWebhook works."}' "$url"
```

## Uptime check

`.github/workflows/uptime.yml` runs every 10 minutes (and on demand from the Actions tab). It
requests `${APP_URL}/readyz` up to four times over about a minute and a half. If it stays red,
the run opens an issue titled **Uptime: /readyz is failing** with the label `incident` (created
on first use), or updates the open one with the latest time, status code and check statuses. The
first green run afterwards closes the issue with a comment. GitHub notifies watchers of new
issues; turn on issue notifications for the repository (or the GitHub mobile app) to get them.

It is **off until go-live**: unless the repository variable `UPTIME_ENABLED` is `true`, every
run only prints a notice and exits successfully. `APP_URL` is already set for the deploy
workflow; the check uses the same variable.

- **Enable at go-live (C5):** *Settings → Secrets and variables → Actions → Variables → New
  repository variable*: `UPTIME_ENABLED` = `true`. Then run the workflow once by hand and check
  that it reports `ready`.
- **Pause** (planned maintenance): set `UPTIME_ENABLED` to `false`. An open incident issue stays
  open until a later green run, or close it by hand.

GitHub may delay scheduled runs by several minutes under load, and pauses schedules in
repositories without activity for 60 days. Treat it as a backstop for the alert webhook, not a
pager.

## Logs

### Where they go and how they are rotated

| Source | Location | Rotation |
|---|---|---|
| api, postgres, backup containers | Docker's `json-file` driver | Set in `compose.prod.yml` (`x-logging`): 10 MB per file, 5 files per container, so at most 50 MB each. Applies to these containers only, not the Docker daemon's default |
| Host nginx for the Loomcast site | `/var/log/nginx/loomcast.access.log`, `/var/log/nginx/loomcast.error.log` | The host's existing nginx logrotate rule (`/etc/logrotate.d/nginx` covers `/var/log/nginx/*.log`). Loomcast adds no rule of its own |
| Deploy script | syslog tag `loomcast-deploy`, plus `/opt/loomcast/state/history` | journald or syslog, as configured on the host |
| Cloudflare ranges refresh | syslog tag `loomcast-cloudflare-ips` | As above |

Container logs are removed with the container: a deploy that recreates the api starts a new
log. Copy anything needed for an incident before redeploying.

To confirm the nginx rule covers the Loomcast files without rotating anything, run logrotate in
debug mode (it only prints what it would do):

```bash
logrotate -d /etc/logrotate.d/nginx 2>&1 | grep -A3 loomcast
```

### Reading them

```bash
docker compose -p loomcast logs --since 1h api           # the last hour
docker compose -p loomcast logs -f --tail=100 api        # follow
docker compose -p loomcast logs --since 24h backup       # the nightly backup
docker compose -p loomcast ps                            # state and health of each container
journalctl -t loomcast-deploy --since today              # deploys and rollbacks
tail -n 50 /var/log/nginx/loomcast.error.log
```

The api writes one JSON object per line (pino). Levels: 30 info, 40 warn, 50 error, 60 fatal.
Credentials, cookies, keys and the alert webhook are redacted before a line is written. Useful
filters (`jq` on the host):

```bash
api_logs() { docker compose -p loomcast logs --no-log-prefix --since "${1:-1h}" api; }

api_logs 1h  | jq -cR 'fromjson? | select(.level >= 50)'                 # errors only
api_logs 24h | jq -cR 'fromjson? | select(.alert != null)'               # alerts raised
api_logs 1h  | jq -cR 'fromjson? | select(.msg == "readiness check failed") | .checks'
api_logs 1h  | jq -cR 'fromjson? | select(.status >= 500) | {time, method, path, requestId}'
api_logs 1h  | jq -cR 'fromjson? | select(.requestId == "<id>")'          # one request
```

Requests to `/healthz` and `/readyz` are logged at debug level, so probes do not fill the log.
Set `LOG_LEVEL=debug` in `api.env` only while investigating, then put it back to `info`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/readyz`: `database` error | Postgres down or restarting, or the pool exhausted | `docker compose -p loomcast ps`, `logs postgres`; the api reconnects by itself once Postgres is healthy |
| `/readyz`: `storage` error | R2 unreachable, token revoked or expired, bucket renamed | The detail on the ops status (`HEAD bucket ... failed: <name> (http <status>)`); `403` means the token, `404` the bucket name in `S3_BUCKET`. See [r2.md](r2.md) |
| `/readyz`: `scheduler` error | No good tick for over a minute, usually database trouble | `scheduler.lastTickError` on the ops status and the api logs; it recovers on the next good tick |
| Deploy rolled back because `/readyz` stayed red | One of the above in the new release's environment | `deploy.sh status`, then the api logs of the failed start |
| Uptime issue opened but the site works | A short outage during a restart, or GitHub's runner could not reach Cloudflare | The issue closes itself on the next green run; check the run log |
| `backup.stale` alert | The backup container is stopped, or `BACKUP_AT` changed | `docker compose -p loomcast ps backup`, `logs backup`; [backup-and-restore.md](backup-and-restore.md) |
| `backup.unreadable` alert, or `backup.status` is `unreadable` | Mount missing or wrong permissions | `ls -ld /opt/loomcast/backups` must show `drwx--x--x` owned by uid 70; `last-success.json` must be mode 0644 |
| No alerts arrive | Webhook not set, wrong format, or the receiver refuses it | `alerts.configured` on the ops status; `could not deliver an alert to the webhook` lines in the logs give the HTTP status or network error; send a test message as above |

## Owner checkpoints

- [ ] **C10, alert webhook.** Choose where alerts go and set `ALERT_WEBHOOK_URL` and
  `ALERT_WEBHOOK_FORMAT` in `api.env` and `backup.env`. Options, simplest first:
  1. **ntfy** (`ntfy`): a long random topic on ntfy.sh, or a self-hosted server; phone push with
     the ntfy app. Free, no account needed; anyone who learns the topic can read it.
  2. **Discord or Slack** (`slack`): an incoming webhook into a private channel. Discord needs
     `/slack` appended to the webhook URL.
  3. **Generic JSON** (`json`): any receiver of your own.

  Then send a test message (above) and check it arrives.
- [ ] **Go-live (C5): enable the uptime check** by setting the repository variable
  `UPTIME_ENABLED` to `true`, then run the workflow once by hand.
- [ ] After go-live, open the ops status once and check `gitSha`, `readiness`, and that
  `backup.status` is `ok` after the first nightly backup.
