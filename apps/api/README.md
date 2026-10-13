# @loomcast/api

The Loomcast API server: Hono on Node, cookie sessions for the web app, bearer tokens for MCP
clients and studio agents, the job service, and the admin CLI. In production it also serves the
built web app, so the browser only ever talks to one origin.

## Scripts

```bash
pnpm --filter @loomcast/api dev        # tsx watch src/server.ts on API_PORT (8790)
pnpm --filter @loomcast/api build      # tsdown: dist/server.mjs and dist/cli/admin.mjs
pnpm --filter @loomcast/api start      # node dist/server.mjs
pnpm --filter @loomcast/api test       # vitest against per-file Postgres databases
pnpm --filter @loomcast/api typecheck
```

## Configuration

`src/env.ts` validates the environment at startup and lists every problem at once. Outside
production the repository's `.env` is loaded first; variables already set win.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string |
| `APP_ORIGIN` | required | Origin of the web app; unsafe requests must come from it |
| `PUBLIC_BASE_URL` | required | Public base URL for published media |
| `API_PORT` | `8790` | Port to listen on |
| `API_HOST` | `127.0.0.1`, or `0.0.0.0` in production | Interface to bind |
| `NODE_ENV` | `development` | `production` switches on `__Host-` cookies and static serving |
| `LOG_LEVEL` | `info` | pino level |
| `WEB_DIST_DIR` | unset | Built web app to serve in production |
| `TRUST_PROXY` | `false` | Take the client address from the last `X-Forwarded-For` entry |

## Layout

| Path | Contents |
|---|---|
| `src/app.ts` | `createApp(deps)`: middleware, health checks, the default-deny guard, module registration |
| `src/server.ts` | `startServer(deps, {port, host})` and the process entry point with graceful shutdown |
| `src/deps.ts` | `AppDeps` (db, bus, clock, logger, config, lifecycle, httpServer) and `ModuleDeps` |
| `src/lib/` | Event bus, rate limiter, audit log, crypto, passwords, transactions, errors, logger |
| `src/modules/<name>/index.ts` | One module each: `register(app, deps)` |
| `src/cli/admin.ts` | The admin CLI |

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
