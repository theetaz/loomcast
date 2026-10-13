# Architecture

Loomcast is an invite-only platform for producing short technology videos. Scripts and
conversations live in a web app; a studio agent on the owner's workstation runs producer
sessions and renders; finished videos are published on a schedule. One installation is one
workspace with a handful of users.

## Components

```text
                         Browser                     MCP clients
                            │ HTTPS: /api, SSE          │ HTTPS: /mcp (bearer token)
                            ▼                           ▼
 ┌───────────────────── api (Node 24, one process) ───────────────────────┐
 │ Hono HTTP                                                              │
 │   /api/*       REST with cookie sessions                               │
 │   /api/stream  server-sent events for the browser                      │
 │   /mcp         MCP over streamable HTTP, stateless, bearer tokens      │
 │   /bridge/v1   WebSocket hub for studio agents, device tokens          │
 │   static SPA   the built web app (production)                          │
 │ job dispatcher and lease reaper · in-process typed event bus           │
 └──────────────┬───────────────────────────────────────▲─────────────────┘
                │                                       │ outbound WebSocket
        ┌───────▼───────┐                               │ (no inbound ports)
        │ Postgres 17   │                ┌──────────────┴─────────────────────┐
        └───────────────┘                │ Workstation                        │
                                         │ studio agent (daemon and CLI)      │
 Object storage (S3 API):                │   job allow-list → producer        │
 Cloudflare R2 in production,            │   sessions in ~/Loomcast/projects/ │
 SeaweedFS locally                       │   studio/ rendering workspace      │
                                         └────────────────────────────────────┘
```

| Component | Package | Role |
|---|---|---|
| API | `apps/api` (`@loomcast/api`) | REST, sessions, live events, job queue and dispatch, bridge hub, MCP server, admin CLI; serves the web app in production |
| Web app | `apps/web` (`@loomcast/web`) | React 19 single-page app built with Vite, TanStack Router and Query |
| Studio agent | `apps/studio-agent` (`@loomcast/studio-agent`) | Pairs a workstation, keeps the bridge connection, runs allow-listed jobs |
| Contracts | `packages/contracts` | Zod schemas and types for everything that crosses a process boundary |
| Database | `packages/db` | Drizzle schema, SQL migrations, client, migration runner, test-database harness |
| UI kit | `packages/ui` | Loomcast theme, shadcn/ui components, brand marks, motion utilities |
| End-to-end tests | `tests/e2e` | Playwright smoke with a fake studio agent |
| Studio workspace | `studio/` | Rendering scripts, style library and templates |

### Decisions

- **One origin.** In production the API serves the built web app, so there is no CORS and the
  session cookie stays simple. In development the Vite dev server proxies `/api`, `/mcp` and
  `/bridge` to the API.
- **SSE for the browser, WebSocket only for the bridge.** The browser keeps one `EventSource` on
  `/api/stream`.
- **One API process.** The bridge hub, dispatcher and reaper run inside it, and the event bus is
  in memory. Job claims use `SELECT … FOR UPDATE SKIP LOCKED`, so a second process would stay
  safe. There is no Redis.
- **Internal packages are TypeScript source** (`exports: {".": "./src/index.ts"}`). Only the
  API and the studio agent are bundled for production (tsdown); the web app builds with Vite.
- **No tenancy.** A project is the unit that owns conversations, the knowledge base and content.
- **The workstation never listens.** The studio agent dials out, so it works behind NAT and
  needs no open ports.

## Data model

Postgres 17 through Drizzle. Enumerations are defined once as arrays in `@loomcast/contracts`
and mirrored as pg enums. Migrations are append-only SQL in `packages/db/migrations`.

| Table | Purpose |
|---|---|
| `users` | Accounts: lowercase email, argon2id password hash, role `owner` or `admin`, disabled time |
| `sessions` | Browser sessions; the id is the sha256 of the cookie token |
| `api_tokens` | MCP, device and job tokens: kind, hashed secret, prefix, scopes, expiry, revocation |
| `password_tokens` | One-time set-password links (hash only) |
| `pairing_codes` | Single-use device pairing codes (hash only), 10-minute expiry |
| `devices` | Paired studio agents and their tokens, last seen time, revocation |
| `projects` | Workspace projects: unique slug, name, status `active` or `archived` |
| `conversations` | Chats in a project, with the producer session id and the device that holds it |
| `messages` | User, assistant, system and event messages; `client_message_id` de-duplicates sends |
| `jobs` | The job queue: type, status, payload, result, error, attempts, device affinity, lease |
| `job_events` | Durable job events, unique per `(job_id, seq)` |
| `kb_entries`, `kb_references` | The knowledge base: brainstorms, references, decisions, notes and session summaries, with full-text and trigram search |
| `audit_log` | Sign-ins, token, device, user and project changes |

Job types form a fixed allow-list (`jobRegistry` in the contracts): each has a payload and result
schema, durable event kinds, a timeout, a retry policy and a concurrency class. The server checks
payloads before a job is queued, and the agent checks them again before it runs one. No job type
carries a shell command.

## Live events

Writes publish typed events on the in-process bus once their transaction commits. The browser
receives them on `GET /api/stream` (server-sent events with ids `<epoch>-<seq>`, a replay of the
last 1 000 through `Last-Event-ID`, a heartbeat every 15 seconds, and streams that end after 30
minutes so the browser reconnects). The union is `LiveEvent` in `packages/contracts/src/events.ts`:
project, conversation message and delta, job update and activity, device status, knowledge-base
and content events, and `resync`.

## Studio agent and the bridge

The studio agent is paired once with a code from Settings → Devices and then holds one
WebSocket to `/bridge/v1`. The server assigns queued jobs to it when it has free credits; the
agent streams progress back as durable events (stored and acknowledged) and ephemeral text
deltas. Jobs wait in the queue while the agent is offline. The protocol, the job lifecycle and
the reliability rules are in [bridge-protocol.md](bridge-protocol.md).

In the web app a project page has three tabs: **Overview** (the default, with the description,
recent knowledge and recent conversations), **Chat** (`/projects/<slug>/chat`, the
conversations with the studio agent; `?conversation=<id>` opens one) and **Knowledge** (the
knowledge base). Sending a chat message queues a `producer.chat` job, which runs one
conversation turn in a producer session inside the project's workspace directory
(`~/Loomcast/projects/<projectId>`). The session id is stored on the conversation, so the next
turn resumes it on the same device.

## MCP server

`/mcp` serves tools to any MCP client over streamable HTTP with an access token (`lc_mcp_…`,
scopes `mcp:read`, `mcp:write`, `mcp:admin`). Producer sessions get per-job tokens bound to one
project. See [mcp.md](mcp.md).

## Security model

- **No sign-up.** The owner is created with the admin CLI; other users by invitation. The first
  account must be the owner, and there is one owner.
- **Passwords.** argon2id (19 MiB, 2 iterations), at least 12 characters. Unknown emails are
  verified against a dummy hash so timing does not reveal which accounts exist.
- **Sessions.** 32 random bytes stored as sha256; the cookie is `lc_session` in development and
  `__Host-lc_session` (Secure) in production, HttpOnly, SameSite=Lax, 30 days sliding.
- **CSRF.** Unsafe `/api/*` requests need `Origin` equal to `APP_ORIGIN` (or
  `Sec-Fetch-Site: same-origin`) and `Content-Type: application/json`.
- **Separate credentials.** `/mcp` and `/bridge/v1` accept bearer tokens only and never read
  cookies; cookie routes never accept bearer tokens. The bridge refuses any request with an
  `Origin` header, and MCP any `Origin` but the app's.
- **Tokens.** Prefixed (`lc_mcp_`, `lc_dev_`, `lc_job_`), stored as sha256, shown once, scoped
  and revocable.
- **Rate limits** (in memory): sign-in 5 a minute per address and email and 20 per address;
  pairing exchanges 10 a minute per address; MCP 120 requests a minute per token.
- **Producer sandbox.** Producer sessions get a tool allow-list, writes confined to the project
  workspace (checked after resolving symlinks), and no user-level settings or hooks.
- **Audit log** for sign-ins, tokens, devices, users and projects.
- **Headers.** `secureHeaders` with a Content Security Policy (`default-src 'self'`, no frames);
  fonts are self-hosted.

## Where to go next

- [Local development](local-development.md): the stack, scripts, pairing, MCP and the M1
  acceptance runbook.
- [Bridge protocol](bridge-protocol.md).
- [MCP server](mcp.md).
- Package READMEs: [`apps/api`](../apps/api/README.md), [`apps/web`](../apps/web/README.md),
  [`apps/studio-agent`](../apps/studio-agent/README.md),
  [`packages/contracts`](../packages/contracts/README.md), [`packages/db`](../packages/db/README.md),
  [`packages/ui`](../packages/ui/README.md).
