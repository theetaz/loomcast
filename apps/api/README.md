# @loomcast/api

The Loomcast API server: Hono on Node, cookie sessions for the web app, bearer tokens for MCP
clients and studio agents, the job service, and the admin CLI. In production it also serves the
built web app, so the browser only ever talks to one origin.

## Scripts

```bash
pnpm --filter @loomcast/api dev        # tsx watch src/server.ts on API_PORT (8790)
pnpm --filter @loomcast/api build      # tsdown: dist/server.mjs and dist/cli/{admin,vault}.mjs
pnpm --filter @loomcast/api start      # node dist/server.mjs
pnpm --filter @loomcast/api test       # vitest against per-file Postgres databases
pnpm --filter @loomcast/api typecheck
pnpm --filter @loomcast/api run vault:rotate -- --dry-run   # see "Token vault"
```

## Configuration

`src/env.ts` validates the environment at startup and lists every problem at once. Outside
production the repository's `.env` is loaded first; variables already set win.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string |
| `APP_ORIGIN` | required | Origin of the web app; unsafe requests must come from it |
| `PUBLIC_BASE_URL` | required | Base URL of the public media bucket (published renders) |
| `API_PORT` | `8790` | Port to listen on |
| `API_HOST` | `127.0.0.1`, or `0.0.0.0` in production | Interface to bind |
| `NODE_ENV` | `development` | `production` switches on `__Host-` cookies and static serving |
| `LOG_LEVEL` | `info` | pino level |
| `WEB_DIST_DIR` | unset | Built web app to serve in production |
| `TRUST_PROXY` | `false` | Take the client address from the last `X-Forwarded-For` entry |
| `S3_ENDPOINT` | required in production | S3 API endpoint: R2 in production, SeaweedFS locally |
| `S3_REGION` | `auto` | Signing region (R2 expects `auto`) |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style URLs (`<endpoint>/<bucket>/<key>`) |
| `S3_BUCKET` | `loomcast-media` | Private bucket for every upload |
| `S3_PUBLIC_BUCKET` | `loomcast-public` | Public-read bucket served at `PUBLIC_BASE_URL` |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | required in production | Object storage keys |
| `ASSET_VERIFY_MAX_BYTES` | 512 MiB | Largest upload finalize hashes itself when the store kept no checksum |
| `LOOMCAST_ENCRYPTION_KEY` | required in production | Token vault key: 32 random bytes, base64 (`openssl rand -base64 32`) |
| `LOOMCAST_ENCRYPTION_KEY_VERSION` | `1` | Version stored with values the current key seals |
| `LOOMCAST_ENCRYPTION_KEYS_PREVIOUS` | unset | Earlier keys during a rotation: `version:base64key,...` |
| `SCHEDULER_ENABLED` | `true` | Runs the scheduled task loop in this process |
| `SCHEDULER_TICK_MS` | `5000` | Pause between two claims of due tasks |
| `PUBLISHING_MODE` | `dry-run` | `dry-run` records what would be posted; `live` posts |
| `PUBLISHING_ENABLED` | `true` | `false` pauses publishing |
| `CADENCE_HORIZON_DAYS` | `14` | How many days ahead cadence slots are planned |
| `ALERT_WEBHOOK_URL` | unset | Webhook for alerts (a secret); unset logs alerts only |
| `ALERT_WEBHOOK_FORMAT` | `json` | `json`, `ntfy` or `slack` (Slack-compatible incoming webhook) |
| `LOOMCAST_GIT_SHA` | unset | Commit of the build, shown on the ops status; the image sets it |
| `BACKUP_DIR` | unset | Read-only backup directory with `last-success.json` (`/backups` in production) |

Outside production, `S3_ENDPOINT`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` may all be left out (not
just some of them): the API then starts without object storage, and uploads and downloads answer
503 `storage_unavailable`. Likewise `LOOMCAST_ENCRYPTION_KEY` may be left out outside production;
storing or reading channel credentials then answers 503 `vault_unavailable`. A key that is not
exactly 32 bytes is refused at startup.

## Layout

| Path | Contents |
|---|---|
| `src/app.ts` | `createApp(deps)`: middleware, health checks, the default-deny guard, module registration |
| `src/server.ts` | `startServer(deps, {port, host})` and the process entry point with graceful shutdown |
| `src/deps.ts` | `AppDeps` (db, bus, clock, logger, config, lifecycle, httpServer) and `ModuleDeps` |
| `src/lib/` | Event bus, rate limiter, audit log, crypto, passwords, transactions, errors, logger |
| `src/lib/storage/` | Object storage: presigned PUT and GET, verification reads, `promoteToPublic` |
| `src/lib/vault.ts` | Token vault: AES-256-GCM sealing of channel credentials, key rotation |
| `src/lib/health.ts` | Readiness check registry behind `/readyz` |
| `src/lib/alerts.ts` | Webhook alerts with de-duplication per key |
| `src/modules/ops/` | Readiness checks, the backup monitor and `GET /api/ops/status` |
| `src/modules/<name>/index.ts` | One module each: `register(app, deps)` |
| `src/modules/scheduler/` | Scheduled task loop, task handlers registry and the admin endpoints |
| `src/cli/admin.ts` | The admin CLI |
| `src/cli/vault.ts` | The vault CLI (`vault:rotate`) |

## Writing a module

Each module exports `register(app, deps: ModuleDeps)`. It builds its own `Hono<AppEnv>` router,
adds routes, mounts it with `app.route("/", router)` and returns it. Routes must be added before the
router is mounted. `createApp` already registers every module, so a module never edits `app.ts`.

`ModuleDeps` carries, besides the app deps:

- `auth`: the guards below.
- `sessions`, `tokens`: the session and token services. `tokens.create`, `tokens.verify(raw, kind)`
  and `tokens.revoke` cover MCP and device tokens. Job tokens (`lc_job_…`) are minted only by the
  job dispatcher with `tokens.mintJobToken` and revoked with `tokens.revokeForJob`.
- `jobs`: `jobs.enqueue(tx, input)` and `jobs.get(id)`.
- `presence.connectedDevices()`: an empty set until the bridge module replaces it.
- `lifecycle.onClose(hook)`: close sockets, streams and timers during shutdown.
- `httpServer`: the Node server when served by `startServer` (the bridge attaches `upgrade`).
- `storage`: object storage (below). `AppDeps.storage` overrides the S3 client built from config.
- `assets`: uploads, finalize and downloads of stored files, shared by REST and the MCP tools.
- `scheduler`: server-side scheduled tasks (below). Register handlers in `register`.
- `vault`: encryption of channel credentials (below).
- `alert(alert)`: raises an alert (below). Never throws.
- `health`: the readiness registry; `health.register(name, check)` adds a check to `/readyz`.

### Object storage and assets

Bytes never pass through the API. `POST /api/assets/uploads` (or `deps.assets.createUpload`)
inserts a `pending` asset and returns a 15-minute presigned PUT whose content type, length and
`x-amz-checksum-sha256` are signed; the client sends exactly the returned headers. Uploads are
deduplicated per owner: the same file uploaded again as the same kind for the same item (or, without
`itemId`, as the project's project-level media, such as reference media) returns the existing asset
(`upload: null` once it is ready). Another item never gets that asset back; it uploads its own copy,
so a version can always use it. The private key follows the owner:
`projects/<projectId>/items/<itemId>/<kind>/<sha256>.<ext>` or
`projects/<projectId>/media/<kind>/<sha256>.<ext>`, so every object belongs to one asset and
deleting it never affects another. Assets stored earlier keep their
`projects/<projectId>/<kind>/<sha256>.<ext>` keys. `POST /api/assets/:id/finalize`
checks the stored size and the checksum the store verified (or hashes the object, up to
`ASSET_VERIFY_MAX_BYTES`, when the store kept none), then marks the asset `ready`, or `failed` and
deletes the object. `GET /api/assets/:id/url` presigns a one-hour GET. The recurring
`assets.cleanup` scheduled task (hourly) deletes pending uploads older than 24 hours.

`storage.promoteToPublic(key)` copies a private object to the public bucket under
`p/<ulid>/<sha256>.<ext>` and returns its anonymous URL under `PUBLIC_BASE_URL`. Only the publisher
uses it, for final renders. The CSP allows the S3 endpoint and `PUBLIC_BASE_URL` origins in
`connect-src`, `img-src` and `media-src`.

### Scheduled tasks

Tasks are server-side work that runs at a set time (cadence planning, production ahead of a slot,
publishing, status polls, asset cleanup). They never reach the studio agent. Each kind is listed
in `scheduledTaskRegistry` (`@loomcast/contracts`) with its payload schema, attempts, backoff base
and lease.

- **Handlers.** A module calls `deps.scheduler.register(kind, handler)` in `register`. The handler
  receives `{task, payload, attempt, signal, logger, now}`. Pass `signal` to every request: it
  aborts when the lease is lost or the server stops. It may return `{next: Date, payload?}` to
  schedule the same kind again under the same dedupe key (completion and the new task are written
  in one transaction).
- **Enqueueing.** `deps.scheduler.enqueue(tx?, kind, payload, {runAt, dedupeKey, onDuplicate})`
  validates the payload (ids only, never secrets). With a dedupe key, a pending task takes the new
  `runAt` (`onDuplicate: "keep"` leaves it alone).
- **Loop.** Under `startServer` with `SCHEDULER_ENABLED`, every `SCHEDULER_TICK_MS` the loop claims
  up to 10 due tasks with `FOR UPDATE SKIP LOCKED` (at most 10 run at once per process), so any
  number of processes can run it and each task runs once. Leases are renewed every `leaseMs / 2`.
- **Failures.** Throw `TaskFailure(code, message, {retryable, retryAfterMs})`; its message is shown
  to admins, so keep secrets out of it. Any other error is stored as `handler_error` with a
  generic message and logged. A retryable failure waits `min(base · 2^(attempt − 1), 1 h) ± 20%`;
  after the last attempt the task is `dead` (audit row `scheduler.task.dead`, `task.dead` event
  and an alert). A non-retryable one is `failed` at once (audit row and alert). Alerts go
  through `deps.alert` (below).
- **Recurring tasks.** `cadence.plan` and `assets.cleanup` run hourly under the dedupe key
  `recurring:<kind>`, once a handler for them is registered. The loop re-checks every hour that
  each is queued.
- **Stopping.** On shutdown the loop stops claiming and waits up to 20 s for running handlers, then
  aborts them and puts their tasks back to `pending`.
- **Health.** `deps.scheduler.health()` returns `{status: ok|stalled|disabled|stopped, lastTickAt,
  inFlight, ...}` for the readiness registry; `queueDepths()` counts tasks per status.
- **Admin.** `GET /api/scheduler/tasks?status=&kind=&cursor=&limit=` and
  `POST /api/scheduler/tasks/:id/retry` (a `failed` or `dead` task; 409 otherwise, or when another
  task holds its dedupe key) for the owner and admins.

### Health, ops status and alerts

- **`/healthz`** is liveness only: the process answers. The container healthcheck uses it.
- **`/readyz`** runs every check in `deps.health` at once, each with a 2 s timeout, and answers
  200 or 503 with `{status, checks: {name: ok|error|skipped}}`. Built in: `database`
  (`select 1`), `storage` (HEAD on the private bucket, reused for 60 s when good and 10 s when
  failing; `skipped` without S3 settings outside production) and `scheduler` (red when
  `stalled`, `skipped` when disabled or not running in this process). During shutdown every
  check is `skipped` and the answer is 503. Details stay out of the public answer.
- **`GET /api/ops/status`** (owner only) adds the details: version and `LOOMCAST_GIT_SHA`,
  uptime, each check's detail and duration, the scheduler's last tick and queue depths, the last
  backup from `BACKUP_DIR/last-success.json` and whether a webhook is configured.
- **Alerts.** `deps.alert({key, title, message, data})` logs at error level and posts to
  `ALERT_WEBHOOK_URL`, at most once an hour per `key` (in memory, per process). Keys are
  `<kind>:<subject>`: `task.dead:<taskId>`, `task.failed:<taskId>`, `post.failed:<postId>`,
  `channel.reauth:<channelId>`, `backup.stale`, `backup.unreadable`. `data` holds ids and codes
  only. `AppDeps.alert` replaces the webhook (tests).
- **Backups.** With `BACKUP_DIR`, a served process reads the backup status at start and every
  hour, and alerts when the last success is older than 26 hours (or none exists 26 hours after
  the start). See `docs/runbooks/monitoring.md`.

### Token vault

`deps.vault` seals channel credentials with AES-256-GCM: `vault.encrypt(value, channelAad(id))`
returns `{secretCiphertext, secretNonce, keyVersion}` for the `channels` columns (ciphertext with
the 16-byte tag appended, a random 12-byte nonce), and `vault.decrypt(sealedSecretOf(row),
channelAad(row.id))` opens it. The additional data binds a value to its row. Never select the
`secret_*` columns into a response or a log line; the logger redacts them as a safety net.

**Rotating the key.** Generate a new key, set it as `LOOMCAST_ENCRYPTION_KEY` with the next
`LOOMCAST_ENCRYPTION_KEY_VERSION`, and move the old one to `LOOMCAST_ENCRYPTION_KEYS_PREVIOUS`
(`1:<old key>`). Restart, then run `pnpm --filter @loomcast/api run vault:rotate -- --dry-run` and
`vault:rotate` (in the production image: `node dist/cli/vault.mjs rotate`). It seals every value
again with the current key in one transaction and refuses when a row uses a key version that is
not configured. Remove the previous key once it reports success.

### Authentication

- **Default deny.** Every `/api/*` request passes the CSRF check and needs a cookie session,
  except the routes `@loomcast/contracts` marks `auth: "none"` (login and device pairing). A public
  route applies its own checks; login applies `auth.csrfGuard`.
- **`currentUser(c)`** and **`currentSession(c)`** from `modules/auth` read the signed-in user.
- **CSRF.** Unsafe methods need `Origin` equal to `APP_ORIGIN` (or, without `Origin`,
  `Sec-Fetch-Site: same-origin`) and `Content-Type: application/json`. Otherwise 403.
- **Bearer tokens.** Routes outside `/api` (`/mcp`, `/bridge/v1`) use
  `deps.auth.requireBearer(kind, scopes)`, which never reads cookies. `currentToken(c)` returns
  the verified token. Cookie routes never accept bearer tokens.
- **Users and set-password links.** Only the owner lists, invites, resets and disables users
  (`/api/users`). An invitation creates the account without a password and returns a one-time
  link, `${APP_ORIGIN}/set-password#token=…`, valid for 7 days (reset links: 24 hours). The token
  travels in the fragment, so it never reaches a server log; only its sha256 is stored, and a new
  link voids the user's unused ones. `POST /api/auth/password-tokens/inspect` and
  `POST /api/auth/set-password` are public, apply the Origin check and allow 10 requests a minute
  per address. Setting a password ends every session of the account; the user then signs in.
  Disabling a user ends their sessions, MCP and job tokens and unused links.
- **Job tokens.** When the dispatcher claims a job whose type has `mcpAccess` other than `none`,
  it mints a job token in the same transaction (bound to the job and its project, with the
  access level's scopes, expiring after the type's timeout plus one lease) and sends it once in
  `job.assign.credentials`. Every terminal transition and every re-queue revokes it.
- **Rate limits.** `createRateLimiter({capacity, intervalMs}, deps.clock)` with `consume(limiter,
  key)` or the `rateLimit(limiter, keyFn)` middleware answers 429 with `Retry-After`.

### Errors

Throw an `HttpError` (helpers in `lib/errors.ts`); the error handler turns it into an `ApiError`
body. `readJson(c, schema)` and `idParam(c)` in `lib/http.ts` parse bodies and UUID parameters.
Unexpected errors become a 500 without details and are logged.

### Transactions and events

Publish bus events only once the data is committed. Run writes in `transaction(db, fn)` from
`lib/db.ts` and publish with `afterCommit(tx, () => bus.publish(...))`; `jobs.enqueue` does this
for `job.enqueued`. Internal events (`job.enqueued`, `device.revoked`) never reach
`bus.subscribeLive`, which feeds the browser stream.

## Bridge and jobs

The bridge module (`src/modules/bridge/`) is the `/bridge/v1` WebSocket hub for studio agents;
the protocol is described in [docs/bridge-protocol.md](../../docs/bridge-protocol.md).

- **Only under `startServer`.** The hub attaches to the Node server's `upgrade` event through
  `deps.httpServer`, so it runs on the API's own port when the app is served by `startServer`,
  and not at all under `app.request()`. In development the agent connects to
  `http://127.0.0.1:8790`, or to `http://localhost:5173` through the Vite proxy (`/bridge` with
  `ws: true`).
- **Reverse proxies** must pass `Upgrade` and `Connection` and keep the read timeout above 20
  seconds, the server's ping interval.
- **Presence.** The hub replaces `deps.presence.connectedDevices()` with the devices whose
  connection completed `hello`, and publishes `device.status` when one connects or disconnects.
- **Dispatch.** `createDispatcher` (in `modules/jobs`) claims queued jobs for connected agents
  with `FOR UPDATE SKIP LOCKED`, by advertised job type, free credits and device affinity. A
  round runs on `hello`, `credits`, `job.enqueued`, every finished job, and every 5 seconds.
  Enqueue with `deps.jobs.enqueue(tx, …)` inside `transaction()`, so dispatch starts after the
  commit.
- **Lifecycle.** `createJobLifecycle` applies every status change in its own transaction and
  publishes `job.updated`; messages about a job count only from the device that claimed it. The
  reaper (`createReaper`, every 15 seconds) applies the registry's lease-expiry policy, and the
  dispatch tick re-queues jobs not accepted within 30 seconds.
- **Per-type side effects** are `JobTypeHooks` (`onEvent`, `onSucceeded`) in
  `modules/jobs/handlers/`, registered in `defaultJobHooks`. `producer.chat` turns
  `assistant.message` events into conversation messages and stores the producer session id and
  device on the conversation.
- **Shutdown.** The lifecycle hook closes every agent connection with `1001`, stops the timers
  and waits up to 5 seconds for messages already received.

`configureBridge(server, options)` sets the hub's timings before `createApp` runs, and
`bridgeHubFor(server)` returns the hub. Tests use `startBridgeServer` and `FakeAgent` from
`test/bridge-support.ts`, which serve the app on an ephemeral port with the background timers
off, so a test drives sweeps and dispatch rounds itself.

## Admin CLI

```bash
pnpm admin:create --email owner@example.com --name Owner --role owner
pnpm admin:token --email owner@example.com --name Laptop --scopes mcp:read,mcp:write
pnpm admin:reset-password --email owner@example.com
pnpm admin:create --email editor@example.com --name Editor --role admin --invite
```

- The first account must be the owner, there is one owner, and admins can be created once the
  owner exists. Emails are stored in lowercase and must be unused.
- Passwords (12 characters or more) are typed twice at a hidden prompt. With `--password-stdin`, or
  when stdin is not a terminal, the first line of stdin is used:
  `printf '%s\n' "$PASSWORD" | pnpm admin:create ... --password-stdin`.
- With `--invite`, `create` asks for no password and prints a one-time set-password link on
  stdout instead (valid for 7 days). It needs `APP_ORIGIN`.
- `token` prints the secret once on stdout. Only the owner may hold `mcp:admin`.
- `reset-password` ends every session of the account.

In the production image, run `node dist/cli/admin.mjs <command> ...` with `DATABASE_URL` set.
