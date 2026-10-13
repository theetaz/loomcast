# Local development

This guide sets up the whole system on one machine: Postgres and object storage in Docker, the
API and the web app from source, a studio agent paired with them, and an MCP client. It ends
with the milestone 1 acceptance runbook.

## Requirements

- Node.js 22.12 or newer (`.node-version` pins 24).
- pnpm, at the version pinned in the root `package.json`.
- Docker with Compose.
- For the studio agent's producer sessions: the producer runtime signed in on the workstation.
  Without it, use the [fake studio agent](#a-studio-agent-without-a-producer-runtime).

## Ports

| Service | Address | Started by |
|---|---|---|
| Postgres 17 | `127.0.0.1:55434` (user, password and database `loomcast`) | `pnpm stack:up` |
| Object storage (SeaweedFS, S3 API) | `127.0.0.1:59000`, bucket `loomcast-media` | `pnpm stack:up` |
| API | `http://127.0.0.1:8790` | `pnpm dev` |
| Web app (Vite) | `http://localhost:5173` | `pnpm dev` |

The web dev server proxies `/api` (REST and server-sent events), `/mcp` and `/bridge` (with
WebSocket upgrades) to the API, so the browser, MCP clients and the studio agent can all use
`http://localhost:5173`, as they would use the single production origin.

## First-time setup

```bash
pnpm install
cp .env.example .env     # local defaults; never commit the filled-in file
pnpm stack:up            # Postgres and SeaweedFS, waits until healthy
pnpm db:migrate          # applies packages/db/migrations to DATABASE_URL
```

`.env` holds the local settings read by the API, the database scripts and the tests. The values
in `.env.example` match the Compose stack. The ones that matter here:

| Variable | Local value | Used by |
|---|---|---|
| `DATABASE_URL` | the `loomcast` database on port 55434 | API, migrations, admin CLI |
| `TEST_DATABASE_ADMIN_URL` | the `postgres` database on port 55434 | unit and end-to-end tests, which create their own databases |
| `APP_ORIGIN` | `http://localhost:5173` | API: unsafe requests must come from this origin |
| `API_PORT` | `8790` | API |
| `PUBLIC_BASE_URL` | a placeholder | API (published media, later milestones) |
| `S3_*` | the SeaweedFS endpoint and its development keys | object storage (later milestones) |

Variables already set in the environment win over `.env`.

### Create the owner

There is no sign-up. Create the owner account with the admin CLI; it asks for the password twice
(12 characters or more) without echoing it:

```bash
pnpm admin:create --email you@example.com --name "Your Name" --role owner
```

To script it, pass the password on stdin: `printf '%s\n' "$PASSWORD" | pnpm admin:create
--email you@example.com --name "Your Name" --role owner --password-stdin`. Other commands:

```bash
pnpm admin:create --email teammate@example.com --name Teammate --role admin
pnpm admin:token --email you@example.com --name Laptop --scopes mcp:read,mcp:write
pnpm admin:reset-password --email you@example.com
```

Optionally, `pnpm --filter @loomcast/db seed:dev` adds a sample project with a filled knowledge
base for the first owner.

## Running

```bash
pnpm dev
```

This starts the API (`tsx watch`, port 8790) and the Vite dev server (port 5173) in parallel.
Open **http://localhost:5173** and sign in. Use `localhost`, not `127.0.0.1`: the API accepts
unsafe requests only from `APP_ORIGIN`.

`pnpm --filter @loomcast/web dev:mock` runs the web app alone against an in-browser mock API;
see the [web app README](../apps/web/README.md#mock-mode).

Stop the servers with Ctrl-C and the stack with `pnpm stack:down` (the data volumes are kept).

## Pairing a studio agent

1. In the web app, open **Settings → Devices** and choose **Pair a device**. The dialog shows a
   single-use code, valid for 10 minutes, and the command to run.
2. In a terminal at the repository root, run the command from the dialog:

   ```bash
   pnpm agent pair --server http://localhost:5173 --code ABCD-EFGH --name "Studio Mac"
   ```

   The agent stores its device token in `~/.config/loomcast-agent/config.json` (mode 0600). Set
   `LOOMCAST_AGENT_HOME` to another directory to keep a development pairing apart from a real
   one.
3. Start it:

   ```bash
   pnpm agent run
   ```

   The dialog closes and the device shows **Online** in Settings → Devices and in the top bar.
   `pnpm agent status` prints the configuration with the token redacted.

`pnpm agent` runs the CLI from source. The [studio agent README](../apps/studio-agent/README.md)
covers the built binary and the launchd service. The protocol is described in
[bridge-protocol.md](bridge-protocol.md).

### A studio agent without a producer runtime

The end-to-end package includes a fake studio agent that pairs, connects and answers every chat
message with a streamed echo. It is useful for UI work on a machine without the producer
runtime:

```bash
pnpm --filter @loomcast/e2e fake-agent --server http://localhost:5173 --code ABCD-EFGH
```

It keeps no state: pair it with a fresh code each time, and revoke the old devices in Settings
when you are done.

## Connecting an MCP client

1. In the web app, open **Settings → Access tokens** and create a token. Choose **Read** and
   **Write** to use `project.create`. Copy the secret (`lc_mcp_…`); it is shown once.
2. Add the server to the MCP client as a streamable HTTP server with a bearer header. The exact
   file and keys depend on the client; most accept this shape (the Settings page shows it with
   the right URL):

   ```json
   {
     "mcpServers": {
       "loomcast": {
         "type": "http",
         "url": "http://localhost:5173/mcp",
         "headers": { "Authorization": "Bearer ${LOOMCAST_MCP_TOKEN}" }
       }
     }
   }
   ```

   `http://localhost:8790/mcp`, the API directly, works too.
3. Check the token from a terminal:

   ```bash
   curl -s -X POST http://localhost:5173/mcp \
     -H "Authorization: Bearer $LOOMCAST_MCP_TOKEN" \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

The tools, scopes and errors are documented in [mcp.md](mcp.md).

## Tests and checks

```bash
pnpm lint          # Biome
pnpm typecheck
pnpm test          # unit and integration tests; needs the stack and TEST_DATABASE_ADMIN_URL
pnpm build
```

The API and database tests clone a migrated template database into one scratch database per test
file, so they never touch the `loomcast` database and can run alongside `pnpm dev`.

### End-to-end smoke

```bash
pnpm --filter @loomcast/e2e exec playwright install chromium   # once
pnpm test:e2e
```

The smoke (`tests/e2e`) needs only Postgres from the stack. It picks two free ports, creates a
scratch database `loomcast_e2e_<time>_<random>`, migrates it, starts the API and the Vite dev
server, creates an owner with `pnpm admin:create`, and drives the M1 runbook in Chromium with the
fake studio agent: sign in, create a project, queue a message in its Chat tab with no agent,
pair through the dialog's code, watch the reply stream in, resume the producer session, go
offline and back, call the MCP tools with a token from Settings, and sign out. When it ends it stops both servers
and drops the database; databases left by an aborted run are dropped by a later run after six
hours.

- Set `LOOMCAST_E2E_LOG_LEVEL=info` to see the API's log.
- Failures leave a trace and a screenshot in `tests/e2e/test-results/`; open a trace with
  `pnpm --filter @loomcast/e2e exec playwright show-trace <path>/trace.zip`.
- In CI, `.github/workflows/e2e.yml` runs the smoke on pull requests and uploads the report.

## M1 acceptance runbook

Milestone 1 is done when this passes on the workstation.

1. Start the stack, migrate and create the owner:

   ```bash
   pnpm stack:up && pnpm db:migrate
   pnpm admin:create --email you@example.com --name "Your Name" --role owner
   ```

2. Run `pnpm dev` and sign in at http://localhost:5173.
3. Create a project in the UI (**Projects → New project**). It appears in the list.
4. Pair the studio agent (**Settings → Devices → Pair a device**), then run the command shown,
   `pnpm agent pair --server http://localhost:5173 --code …`, and `pnpm agent run`. The device
   shows as online.
5. Open the project, switch to its **Chat** tab (`/projects/<slug>/chat`; the project opens on
   **Overview**) and send a message. The `producer.chat` job reaches the agent, a producer
   session answers, the reply streams into the conversation, and it is still there after a
   reload.
6. Send a follow-up. The reply keeps the context: the conversation's producer session is resumed
   on the same device instead of a new one being started.
7. Stop the agent (Ctrl-C) and send another message in the Chat tab: the status line reads "Waiting for studio agent
   (offline)". Start the agent again and the queued job runs.
8. Create an access token in **Settings → Access tokens** with Read and Write, add the server to
   an MCP client as shown above, and call `project.create`. The new project appears in the open
   project list without a reload.

Steps 1 to 8 are also what `pnpm test:e2e` checks, with the fake studio agent in place of a
producer session.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `pnpm dev` fails with "Port 5173 is already in use" or `EADDRINUSE` on 8790 | Another dev server is running. Find it with `lsof -nP -iTCP:5173 -sTCP:LISTEN` (or `:8790`) and stop it |
| The API exits with "Invalid environment" | `.env` is missing or incomplete. Copy `.env.example` to `.env`; the message lists each missing variable |
| `ECONNREFUSED 127.0.0.1:55434` from migrations or tests | The stack is not running. Run `pnpm stack:up` and check `docker compose ps` |
| Sign-in or any change answers 403 | The page is not served from `APP_ORIGIN`. Open `http://localhost:5173`, not `127.0.0.1:5173`, or change `APP_ORIGIN` |
| Sign-in answers 429 | Too many attempts: 5 a minute per address and email. Wait a minute |
| `pnpm agent pair` says "Pairing was refused (HTTP 401)" | The code is wrong, used or expired: codes last 10 minutes and work once. Open the dialog again for a new code |
| `pnpm agent pair` says "Pairing was refused (HTTP 429)" | More than 10 pairing attempts a minute from this address. Wait a minute |
| `pnpm agent pair` says the server URL must use https | Plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]` |
| The agent logs "re-pair required" and exits | Its token was revoked or the device was deleted. Pair again |
| The agent keeps reconnecting after pairing with `http://localhost:5173` | The bridge goes through the dev server's `/bridge` proxy, so `pnpm dev` must be running (restart it after pulling). Pairing with `--server http://127.0.0.1:8790` talks to the API directly |
| Messages stay "Queued" while the device is online | The agent did not advertise `producer.chat`, which happens when the producer runtime fails to load. Check the agent's log |
| A reply fails with "The producer session on the studio agent is signed out" | Sign the producer runtime in on the workstation, then use Retry |
| A reply fails with "The studio agent lost its connection while working on this" | The agent was away for longer than the 10-minute lease. Use Retry |
| MCP answers 401 | The token is missing, revoked or mistyped; cookies are never accepted on `/mcp` |
| MCP answers 406 | The client must send `Accept: application/json, text/event-stream` |
| MCP answers 403 | The request carried an `Origin` header other than the app's. Browser pages cannot call `/mcp`; MCP clients send no `Origin` |
| An MCP tool call returns `forbidden: …` | The token lacks the tool's scope, for example `mcp:write` for `project.create`. Create a token with that scope |
| Tests fail with "TEST_DATABASE_ADMIN_URL is not set" | Copy `.env.example` to `.env` or export the variable |
| `pnpm test:e2e` cannot launch Chromium | Run `pnpm --filter @loomcast/e2e exec playwright install chromium` |
| Old `t_*`, `loomcast_template_*` or `loomcast_e2e_*` databases pile up | Test runs drop their own databases; a crashed run may leave some. They are safe to drop when no tests are running (templates first need `alter database <name> is_template false`) |
