# Local development

This guide sets up the whole system on one machine: Postgres and object storage in Docker, the
API and the web app from source, a studio agent paired with them, and an MCP client. It ends
with the acceptance runbooks of milestones 1 to 3.

## Requirements

- Node.js 22.12 or newer (`.node-version` pins 24).
- pnpm, at the version pinned in the root `package.json`.
- Docker with Compose.
- For the studio agent's producer sessions: the producer runtime signed in on the workstation.
  Without it, use the [fake studio agent](#a-studio-agent-without-a-producer-runtime).
- For voice and render jobs (milestone 3): ffmpeg, a render browser and the TTS provider key.
  See [Production on the workstation](#production-on-the-workstation-m3).

## Ports

| Service | Address | Started by |
|---|---|---|
| Postgres 17 | `127.0.0.1:55434` (user, password and database `loomcast`) | `pnpm stack:up` |
| Object storage (SeaweedFS, S3 API) | `127.0.0.1:59000`, buckets `loomcast-media` (private) and `loomcast-public` | `pnpm stack:up` |
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
| `PUBLIC_BASE_URL` | the local public bucket | API (published media, milestone 4) |
| `S3_*` | the SeaweedFS endpoint and its development keys | API: presigned uploads and downloads of voice takes, renders, posters and reference media |

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
message with a streamed echo. It also answers production jobs with fixtures (a fixed script and
storyboard, and synthetic bytes uploaded as the voice take, render and poster), so an idea can
be produced through review without a producer runtime, the TTS provider or a renderer. It is
useful for UI work on a machine without them:

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

The smoke (`tests/e2e`) needs Postgres and object storage from the stack. It picks two free
ports, creates a scratch database `loomcast_e2e_<time>_<random>`, migrates it, starts the API
(with the local SeaweedFS when it answers) and the Vite dev server, creates an owner with
`pnpm admin:create`, and drives the runbooks in Chromium with the fake studio agent:

- `specs/calendar.spec.ts` (M4): link a series whose format publishes automatically to a
  planning channel and watch it fill the calendar 14 days ahead, have the first slot (a few
  minutes ahead, one-hour lead time) produced and approved by the system, approve a second
  series' video for a channel that requires approval in the approvals inbox, drag a planned post
  to the next day, and check both posts publish in dry-run at the slot with their `dryrun://`
  permalinks and recorded requests. It waits for the slot, so it takes about five minutes. It
  pauses its series and revokes its device when it ends.
- `specs/kb.spec.ts` (M2): write a brainstorm and find it with ⌘K, have a chat turn save a
  brainstorm over MCP with its job token while the Knowledge tab is open, analyze a reference
  from its transcript, file a session summary with the session-end hook, and invite a user over
  the API who sets a password and signs in. It revokes the device it paired when it ends.
- `specs/pipeline.spec.ts` (M3): publish a skill over MCP and watch the agent sync it, create a
  series whose new format gets a voice, add an idea and produce it through review, check the
  script, storyboard, voice and video tabs, request changes and get version 9 back in review,
  and approve it from the review queue with every version kept. The fake agent reads the item
  over MCP with its job tokens and uploads synthetic media through presigned PUTs to the local
  store. It revokes its device when it ends.
- `specs/smoke.spec.ts` (M1): sign in, create a project, queue a message in its Chat tab with no
  agent, pair through the dialog's code, watch the reply stream in, resume the producer session,
  go offline and back, call the MCP tools with a token from Settings, and sign out.

When it ends it stops both servers and drops the database; databases left by an aborted run are
dropped by a later run after six hours.

- The API under test runs its scheduler every 500 ms and always publishes in dry-run with a
  14-day planning horizon, whatever `.env` says (`apiEnvironment` in `tests/e2e/support/env.ts`).
- `LOOMCAST_E2E_S3` picks the object storage: `auto` (default) uses the local store when it
  answers at `S3_ENDPOINT` (default `http://127.0.0.1:59000`) and skips the pipeline and
  calendar specs otherwise; `required` fails the run instead (CI); `off` skips it. The keys come from `S3_*` or
  `infra/seaweedfs/s3.json`.
- Set `LOOMCAST_E2E_LOG_LEVEL=info` to see the API's log.
- Failures leave a trace and a screenshot in `tests/e2e/test-results/`; open a trace with
  `pnpm --filter @loomcast/e2e exec playwright show-trace <path>/trace.zip`.
- In CI, `.github/workflows/e2e.yml` starts SeaweedFS, runs the smoke on pull requests with
  `LOOMCAST_E2E_S3=required` and uploads the report.

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

## M2 acceptance runbook

Milestone 2 adds the knowledge base, reference analysis, the command palette, invitations and
the session-end hook. It is done when this passes on the workstation, on top of the M1 setup
(stack up, migrated, owner created, `pnpm dev` running, studio agent paired and running). The
[knowledge base guide](knowledge-base.md) describes each part.

1. **A producer chat saves a brainstorm through MCP, and it appears live.** Open a project's
   **Knowledge** tab in one browser tab and its **Chat** tab in another. In the chat, ask the
   studio agent to brainstorm a few hooks and save them to the knowledge base. The producer
   session calls `kb.save_brainstorm` with its job token, and the entry appears in the Knowledge
   tab without a reload.
2. **A pasted reference is analyzed by the producer session.** In **Knowledge → New entry →
   Reference**, paste a link to a short video, say why you liked it, paste its transcript (or
   load a `.srt`, `.vtt`, `.txt` or `.json` file) and save. Choose **Analyze**: the status moves
   from Queued to Analyzing to Analyzed, and the analysis (hook, structure, pacing, retention,
   takeaways) appears next to the transcript. The link itself is never opened by Loomcast.
3. **⌘K search finds it.** Press ⌘K (Ctrl+K), type a word from the brainstorm or the
   reference, and choose the hit: the entry opens.
4. **An invited user sets a password and signs in.** As the owner, open **Settings → Members →
   Invite member**, or call the API:

   ```bash
   # with the owner's session cookie in $COOKIE
   curl -s -X POST http://localhost:5173/api/users/invitations \
     -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
     -H "Cookie: $COOKIE" \
     -d '{"email":"teammate@example.com","name":"Teammate","role":"admin"}'
   ```

   Open the one-time `setPasswordUrl` in a private window, choose a password and sign in on the
   login page it leads to. Opening the link a second time says it was already used.
5. **Optional: the session-end hook files a session summary.** Set it up as in the
   [session hook guide](session-hook.md#checking-it); after a session the summary appears under
   **Sessions** in the project's Knowledge tab.

`pnpm test:e2e` checks steps 1 to 5 with the fake studio agent, whose analysis is a fixed sample
rather than a producer session's.

## Production on the workstation (M3)

Milestone 3 adds the production pipeline: series and formats, script, storyboard, voice and
render jobs on the studio agent, the item page with its review panel, and the review queue. The
[pipeline guide](pipeline.md) explains the states, actions and autopilot; the
[studio runtime guide](studio-runtime.md) explains rendering. On top of the M1 setup:

1. **The TTS provider key**, for voice jobs and media transcription. Store it for the studio
   agent at the hidden prompt, then restart `pnpm agent run`:

   ```bash
   pnpm agent secrets set voice-provider-key
   pnpm agent status        # "Voice provider key: set"
   ```

   It is kept in `~/.config/loomcast-agent/secrets.env` (mode 0600). The provider key variable in
   `studio/.env` (see `studio/.env.example`) works too, as a fallback.
2. **Render tools.** Check them with the studio's pinned HyperFrames CLI, telemetry off:

   ```bash
   export HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1 HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_AUTO_INSTALL=1
   pnpm --filter @loomcast/studio exec hyperframes doctor
   pnpm --filter @loomcast/studio test:smoke    # a five-second render; skipped with the reason if a tool is missing
   ```

   This is `npx hyperframes doctor` run as the pinned version; do not use `npx`, which may fetch
   another one. Renders need ffmpeg, ffprobe and a render browser (`HYPERFRAMES_BROWSER_PATH`, or
   the CLI's cache); nothing downloads a browser on its own.
3. **Skills.** Publish the studio's producer skills; the agent syncs them into
   `~/Loomcast/skills/`:

   ```bash
   pnpm --filter @loomcast/api run skills:seed -- ../../studio/skills
   ```

4. **A voice in the format.** New formats have no voice; paste the TTS provider's voice ID into
   **Voice ID** in the format editor, or production stops before the voice step.

Uploads go straight from the agent (and the browser, for reference media) to object storage with
presigned URLs, so `pnpm stack:up` must be running. The local media bucket accepts browser
uploads from `http://localhost:5173` only (`infra/seaweedfs/s3-init.sh`).

## M3 acceptance runbook

Milestone 3 is done when, on the workstation, an idea in a real format goes through script,
storyboard, voice and render via the studio agent, the review screen plays the result, a request
for changes produces a revised version, approval works and every version is kept. The steps,
including the one-time Mac setup (owner checkpoint C6), are in the
[M3 acceptance runbook](runbooks/m3-acceptance.md).

`pnpm test:e2e` checks the same flow with the fake studio agent, whose script, storyboard and
media are fixtures rather than a producer session's, the TTS provider's and a render's.

## Scheduling and publishing (M4)

Milestone 4 adds cadences, the calendar, approval rules and the publisher. The
[scheduling and publishing guide](scheduling-and-publishing.md) explains the cadence model, the
approval rules, dry-run, dead letters and time zones. Locally everything publishes in dry-run:

- `PUBLISHING_MODE=dry-run` (the default in `.env.example`) records each post's requests and a
  `dryrun://` permalink instead of sending it. Keep it locally; live publishing needs connected
  accounts and is set up as in the guide's [live publishing](scheduling-and-publishing.md#live-publishing)
  section.
- `SCHEDULER_ENABLED=true` runs the scheduled tasks in `pnpm dev`; `SCHEDULER_TICK_MS` (5000)
  is how often it looks for due ones. `PUBLISHING_ENABLED=false` pauses publishing.
- `CADENCE_HORIZON_DAYS` (14) is how far ahead series are planned.
- `LOOMCAST_ENCRYPTION_KEY` is needed only to connect real accounts. Planning channels
  (**Settings → Channels → Add planning channel**) need nothing: they are disconnected and always
  dry-run.

## M4 acceptance runbook

Milestone 4 is done when this passes on the workstation, on top of the M3 setup (stack up,
`pnpm dev` running, studio agent paired and running, skills seeded) with `PUBLISHING_MODE=dry-run`.

1. **A planning channel.** In **Settings → Channels**, add a planning channel (Instagram, say).
   It shows **Dry run** on and a banner says the server only dry-runs.
2. **A cadence.** Open a series' format and set a voice, every day at a time a few minutes past
   the next hour, your time zone, a one-hour lead time and **Publish automatically**. Save. The
   series page's **Cadence** card lists the next slots.
3. **The calendar fills.** On the series page, switch the channel on in the **Channels** card.
   Within a few seconds **Calendar** shows one planned post a day for the next 14 days, titled
   `<series> · <date>`.
4. **Items are produced ahead of each slot.** An hour before the first slot, its item is produced
   (script, storyboard, voice, render) on the studio agent. On reaching review the system approves
   it: the post turns **Queued** and the item **Scheduled**, with a system review in its history.
5. **Approval mode holds.** Add a second planning channel with **Approval** on and switch it on
   for the series too, or use a series whose format says **Wait for approval**. Its video waits in
   **Approvals** with the time left before its slot; its post stays **Planned**. Approve it there
   and the post turns **Queued**. A video left unapproved past its slot shows under **Missed
   posts**, where it can be rescheduled.
6. **Drag rescheduling works.** Drag a planned post to another day or time on the calendar. It
   stays there after a reload; a time less than two minutes ahead is refused.
7. **The dry-run publisher records the payload.** At the slot the posts turn **Published**.
   `GET /api/scheduled-posts/<postId>/attempts` (with the session cookie) shows the attempt with
   `dryRun: true`, the requests the platform would have received (caption, video URL on
   `dry-run.invalid`, credentials `[redacted]`) and the `dryrun://<platform>/<postId>` permalink.
8. **Nothing is dead.** **Settings → Scheduler** lists no dead tasks.

`pnpm test:e2e` checks steps 1 to 8 with the fake studio agent (`specs/calendar.spec.ts`), with
a slot a few minutes ahead instead of the next hour.

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
| An analysis stays "Queued" while the device is online | The agent did not advertise `kb.analyze_reference` (same cause as above), or it is busy with a chat turn: both use the producer credit |
| **Analyze** is disabled | The reference has no transcript. Edit it and paste one |
| An analysis fails with "analysis_invalid" | The producer session's answer did not match the analysis schema twice. Use **Re-analyze** |
| ⌘K finds nothing for a word you can see | The body, tags and transcript match whole words (English stemming); only titles also match by prefix and close spelling. Type the full word; the palette searches from two characters |
| A set-password link says it expired or was already used | Links work once; invitations last 7 days and reset links 24 hours. Create a new one from Settings → Members |
| The session-end hook reports `skipped` or `failed` | See the messages table in the [session hook guide](session-hook.md#checking-it) |
| A reply fails with "The producer session on the studio agent is signed out" | Sign the producer runtime in on the workstation, then use Retry |
| A reply fails with "The studio agent lost its connection while working on this" | The agent was away for longer than the 10-minute lease. Use Retry |
| MCP answers 401 | The token is missing, revoked or mistyped; cookies are never accepted on `/mcp` |
| MCP answers 406 | The client must send `Accept: application/json, text/event-stream` |
| MCP answers 403 | The request carried an `Origin` header other than the app's. Browser pages cannot call `/mcp`; MCP clients send no `Origin` |
| An MCP tool call returns `forbidden: …` | The token lacks the tool's scope, for example `mcp:write` for `project.create`. Create a token with that scope |
| Tests fail with "TEST_DATABASE_ADMIN_URL is not set" | Copy `.env.example` to `.env` or export the variable |
| `pnpm test:e2e` cannot launch Chromium | Run `pnpm --filter @loomcast/e2e exec playwright install chromium` |
| `pnpm test:e2e` skips the pipeline spec | Nothing answered at the object store. Run `pnpm stack:up` (or `docker compose up -d s3 s3-init`) |
| Uploads or media links answer 503 `storage_unavailable` | The API started without `S3_*`. Copy them from `.env.example` and restart `pnpm dev` |
| Production stops before the voice with `voice_not_configured` | The format has no voice ID. Set one in the format editor and produce again |
| A voice or render job fails | See the [studio runtime troubleshooting](studio-runtime.md#troubleshooting) |
| A series has slots but nothing appears on the calendar | It has no channel switched on, the series or its project is paused, or the slot is less than two minutes away. Switch a channel on in the series' **Channels** card |
| A post turns **Missed** | Its time came before its video was approved (or produced). Approve the video and reschedule the post from **Approvals → Missed posts** |
| A channel's **Dry run** switch is locked (`409 dry_run_locked` from the API) | Its tooltip says why: the server is in `PUBLISHING_MODE=dry-run`, or the channel is a planning channel or needs reconnecting. See [dry-run and going live](scheduling-and-publishing.md#dry-run-and-going-live) |
| Due posts stay **Queued** | Publishing is paused (`PUBLISHING_ENABLED=false`) or the scheduler is off (`SCHEDULER_ENABLED=false`); **Settings → Scheduler** shows its last run |
| A task shows in **Settings → Scheduler** as dead | Every attempt failed. Read its last error, fix the cause and use **Retry** |
| Old `t_*`, `loomcast_template_*` or `loomcast_e2e_*` databases pile up | Test runs drop their own databases; a crashed run may leave some. They are safe to drop when no tests are running (templates first need `alter database <name> is_template false`) |
