# Security

How Loomcast protects its accounts, tokens, credentials and the shared production host, what the
automated checks cover, and the findings of the hardening review (M6-06, 2026-10-13, reviewed at
`1da14a4` on `main`). The owner's day-to-day procedures are in
[runbooks/owner-runbook.md](runbooks/owner-runbook.md); what to do when something goes wrong is
in [runbooks/incident-response.md](runbooks/incident-response.md).

## Trust boundaries

```
browser ──HTTPS──▶ Cloudflare ──HTTPS (origin pull)──▶ host nginx ──▶ 127.0.0.1:<port> api container ──▶ postgres (internal network)
studio agent (Mac) ──WebSocket /bridge/v1, POST /api/bridge/pair──┘                               └──▶ R2, Meta, Threads, alert webhook (egress network)
producer session (Mac) ──POST /mcp (job token)──┘
```

- The api publishes only on the host's loopback. nginx is the only way in, and it replaces
  `X-Forwarded-For` with the address it resolved from `CF-Connecting-IP` (trusted only from
  Cloudflare's ranges). With `TRUST_PROXY=true` the api reads the last entry, so rate limits key
  on the real client address. If the api port were ever reachable directly, a client could pick
  its own address and slip past every per-address limit.
- Postgres has no published port and sits on an internal network.
- Containers run with a read-only root filesystem, no capabilities, `no-new-privileges` and
  memory caps (`infra/compose/compose.prod.yml`). The host runs other production apps; nothing in
  Loomcast prunes, reloads or reconfigures anything outside its own compose project and nginx site.

## Who can call what

| Surface | Credential | Notes |
|---|---|---|
| `/api/*` with `auth: "session"` (every route but four, outside `/api/v1`) | `__Host-lc_session` cookie (production): `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain` | 30-day sliding session. Default deny: unknown `/api` paths need a session too. Bearer tokens are never read here. `/api/api-clients` is owner-only |
| `/api/v1/*` (`auth: "api_key"`, the machine API) | Bearer `lc_api_…` of an API client: one workspace and the channels the owner granted (`read`, `write` or `publish`) | Cookies are never read and no CSRF check applies (not a browser surface; no CORS). Default deny: unknown `/api/v1` paths need a key. Acts as the owner, who must still be the owner. 120 requests a minute per client. See [api.md](api.md) |
| `POST /api/auth/login`, `/api/auth/password-tokens/inspect`, `/api/auth/set-password` | None (the body is the credential) | Rate limited per address; same CSRF checks as session routes |
| `POST /api/bridge/pair` | A 10-minute single-use pairing code | Rate limited per address; refuses foreign `Origin` and non-JSON bodies |
| `/mcp` | Bearer `lc_mcp_…` (user) or `lc_job_…` (one job, its workspace only) | Cookies are never read. Foreign `Origin` refused. 120 or 240 requests a minute per token |
| `/bridge/v1` (WebSocket) | Bearer device token with the `bridge` scope | Cookies are never read; revoking a device closes its socket with 4403 |
| `/healthz`, `/readyz` | None | Statuses only, no details; rate limited per address |

### API clients

The owner's other backends call the machine API under `/api/v1` with an API client's key. A client
is bound to one workspace and reaches only the channels of that workspace the owner granted it, each
at a level: `read` (status, permalinks, errors and metrics), `write` (create and schedule posts that
wait for the owner's approval) or `publish` (also approved on the owner's behalf). A channel that
requires approval keeps every post for the owner whatever the level, and dry-run and the publishing
switches apply as usual.

- A channel the client was not granted reads like one that does not exist (`400` with the same
  message), and a post it cannot see is a `404`; it can change only the posts it created.
- The client acts as its owner, because approving and scheduling belong to users in the state
  machine; each request is refused once that account is no longer the owner. One `api.request`
  audit row per write names the client's token as the actor.
- Files are uploaded to short-lived (15-minute) presigned URLs with their size and SHA-256
  signed; on finalize the server checks size, checksum and the leading bytes against the declared
  MIME type before anything can publish them.
- Revoking a client in Settings stops its key on its next request.

### CSRF

Every unsafe request on the cookie routes (and the public auth routes) must come from the app's
origin: `Origin` equal to `APP_ORIGIN`, or no `Origin` with `Sec-Fetch-Site: same-origin`. It must
also be `Content-Type: application/json`, which a plain HTML form cannot send. Anything else is a
403 before the handler runs. `SameSite=Lax` stays because sign-in with Meta and Threads returns
through a top-level GET that needs the session.

### Security headers

Set by the api on every response (nginx adds none). Two content security policies, by route class:

| Route class | Content-Security-Policy |
|---|---|
| The web app (every path outside the next row) | `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: <media>; media-src 'self' blob: <media>; font-src 'self' data:; connect-src 'self' <media>; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `/api`, `/mcp`, `/bridge`, `/healthz`, `/readyz` | `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` |

`<media>` is the S3 endpoint's origin (presigned uploads and downloads) and the origin of
`PUBLIC_BASE_URL`. `'wasm-unsafe-eval'` lets the upload checksum compile WebAssembly; JavaScript
`eval` stays blocked.

Every response also carries:

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |

The clipboard is left allowed: the settings pages copy tokens and pairing codes with it.

### Rate limits

All limits are in-memory token buckets per api process (there is one), reset on restart.

| What | Key | Limit |
|---|---|---|
| Login | client address | 20 a minute |
| Login | client address and email | 5 a minute |
| Set-password link inspect and use | client address | 10 a minute (shared) |
| Password change | user | 5 a minute |
| Device pairing (`/api/bridge/pair`) | client address | 10 a minute |
| Pairing code creation | user | 10 a minute |
| Failed credentials: a session cookie or bearer token that does not verify, on any session route, `/mcp` or `/api/v1` | client address | 30 a minute, then 429 before any lookup. Requests without credentials are not counted |
| `/mcp` | user token / job token | 120 / 240 a minute |
| `/api/v1` | API client | 120 a minute |
| `/healthz`, `/readyz` | client address | 60 a minute |

### Secrets at rest

- Passwords: argon2id. Session, MCP, job, device and API client tokens and set-password links:
  only a hash is stored; the secret is shown once (with `Cache-Control: no-store`) and never
  audited or logged.
- Platform credentials (Meta, Threads, X tokens): AES-256-GCM with a per-row nonce and the row id
  as associated data, under `LOOMCAST_ENCRYPTION_KEY` (versioned; see the rotation steps in the
  owner runbook).
- Server secrets live in `/opt/loomcast/env/*.env` (root, mode 0600), GitHub environment secrets
  (`production`) and the owner's password manager. Never in git.
- On the Mac: the device token in `~/.config/loomcast-agent/config.json` and the TTS provider key
  in `secrets.env` next to it, both mode 0600.
- Logs redact credential-shaped fields (`apps/api/src/lib/logger.ts`).

## Automated checks

- **Security suite** (`apps/api/test/security/`, run with
  `pnpm --filter @loomcast/api test security`):
  - the exact policy and headers of each route class, including error responses;
  - production cookie flags on sign-in and sign-out;
  - CSRF on every unsafe route of the contracts (foreign `Origin`, cross-site without `Origin`,
    form content types), found by iterating `routes`, so a new route is covered automatically;
  - `/mcp` and `/bridge` refuse cookies, and every session route refuses MCP, job, device and
    API client tokens;
  - every machine API route (`auth: "api_key"`) answers 401 without a key, to a session cookie
    (even cross-site) and to MCP, job and device tokens, and an API key does not open `/mcp`;
  - every route the contracts mark public has a known per-address limit (a new public route fails
    the suite until it gets one), plus the probes and the failed-credential limit;
  - disabling a user revokes the devices they paired and closes their bridge connections.
- **Dependency advisories:** the `audit` job in `.github/workflows/ci.yml` runs
  `pnpm audit --prod --audit-level high` on pushes to `main` and weekly.

### Dependency advisories

A high or critical advisory in a production dependency fails CI. Fix it by upgrading (`pnpm up`,
or an `overrides` entry in `pnpm-workspace.yaml` when the fix is in a transitive dependency). Only
when the vulnerable code cannot be reached, add a reviewed exception to `pnpm-workspace.yaml`:

```yaml
auditConfig:
  ignoreGhsas:
    # GHSA-xxxx-xxxx-xxxx: <package> <range>. Not reachable because <reason>.
    # Reviewed <date> by <name>. Expires <date, at most 90 days later>: remove or renew.
    - GHSA-xxxx-xxxx-xxxx
```

There are no exceptions today: `pnpm audit --prod --audit-level high` reports no known
vulnerabilities (2026-10-13). The full audit lists two moderate advisories in `sprintf-js`, reached
only through the `studio` workspace's development tooling (`hyperframes` → `onnxruntime-node` →
`global-agent`), which never ships in the api image.

## Hardening review findings

Status: **fixed** (with tests, in this review), or **open** with the risk and the recommendation.

| ID | Area | Finding | Risk | Status |
|---|---|---|---|---|
| H1 | Headers | Server paths (`/api`, `/mcp`, the probes) carried the web app's CSP. They only answer JSON, so a policy that allows nothing is free defence in depth against a response ever being rendered | Low | Fixed: per-class CSP |
| H2 | Headers | `X-Frame-Options: SAMEORIGIN` disagreed with `frame-ancestors 'none'`; HSTS was 180 days; no `Permissions-Policy` | Low | Fixed: `DENY`, one year, policy above |
| H3 | Rate limits | Session cookies and bearer tokens that fail to verify were never limited, so one client could probe credentials on every session route and on `/mcp` as fast as the database answered | Medium | Fixed: 30 failures a minute per address, then 429 before any lookup |
| H4 | Rate limits | `/healthz` and `/readyz` had no limit; `/readyz` reaches the database | Low | Fixed: 60 a minute per address |
| H5 | Accounts | Disabling a user did not drop the live bridge connections of devices they paired: the device token was refused only on reconnect, so the agent could keep claiming jobs | Medium | Fixed: disabling revokes those devices and tokens and closes the sockets (4403) |
| H6 | Bridge | Failed device-token upgrades on `/bridge/v1` are not rate limited: the hub verifies tokens itself, outside the auth guards. Each attempt costs one indexed hash lookup; device tokens are 256-bit random, so guessing is not practical | Low | Open. Recommendation: count failed upgrades with the same per-address limiter (a small change in `modules/bridge/hub.ts`), or add an nginx `limit_req` zone named `loomcast_bridge` on `location /bridge/` |
| H7 | Login | The per-account login limit is keyed by address and email, so guesses spread over many addresses are limited only by argon2's cost | Low (single owner, strong passwords) | Open, accepted. A global per-email limit would let anyone lock the owner out. Use a long generated password; watch `auth.login.failed` in the audit log |
| H8 | Tokens | MCP tokens may be created without an expiry | Low | Open. Recommendation: give MCP tokens an expiry (90 days) and rotate them; see the owner runbook |
| H9 | Mac | A job token is passed to the producer session on its command line, so other processes of the same macOS user can read it in `ps` while a job runs | Low | Open, accepted (M2-04): job tokens are bound to one job and workspace, expire with the job's timeout and are revoked on every terminal transition |
| H10 | CSP | `style-src` allows `'unsafe-inline'` (component libraries set inline styles) | Low | Open. Scripts stay locked to `'self'`; revisit with style nonces if a library allows it |
| H11 | Rate limits | Limits are per process and reset on restart | Low | Open, accepted while the api runs as one process. Move them to Postgres before scaling out |
| H12 | Revocation | Revoking a device or token with SQL (instead of the web app or the api) does not close live bridge sockets; only the `device.revoked` event does | Low | Documented in the incident runbook: restart the api after revoking with SQL |
| H13 | Audit log | `audit_log` is append-only by convention; the api's database role could change it | Low | Open. Recommendation: copy the audit log off the host with the nightly backup (already encrypted) and keep backups for 90 days, so tampering is visible against an older copy |
| H14 | Static files | The web app's static files are served without a rate limit | Low | Accepted: no database access; Cloudflare's cache and DDoS protection sit in front |

## Checks against the live host

These run from the owner's machine after a deploy (the review itself made no connection to
production):

```bash
curl -sI https://loomcast.prabhavalabs.com/ | grep -iE 'strict-transport|content-security'
# Expect the web app's policy and max-age=31536000; includeSubDomains.

curl -sI https://loomcast.prabhavalabs.com/healthz | grep -iE 'content-security|x-frame'
# Expect default-src 'none' ... and X-Frame-Options: DENY.

curl -s -o /dev/null -w '%{http_code}\n' -X POST https://loomcast.prabhavalabs.com/mcp
# Expect 401 (no bearer token).

curl -s -o /dev/null -w '%{http_code}\n' https://loomcast.prabhavalabs.com/api/v1/me
# Expect 401 (no API key).
```

On the server, confirm the api port is bound to loopback only:
`ss -ltnp | grep "$LOOMCAST_HTTP_PORT"` must show `127.0.0.1:<port>`, never `0.0.0.0` or `*`.
