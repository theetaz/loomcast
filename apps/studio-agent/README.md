# @loomcast/studio-agent

The studio agent links a Mac to a Loomcast server. It opens one outbound WebSocket to the bridge (`/bridge/v1`), so the Mac needs no inbound ports, and runs jobs from a fixed allow-list. It never runs a command taken from a job payload.

## Commands

Build once, then use the `studio-agent` bin (`dist/cli.mjs`). From the repository root, `pnpm agent <command>` runs the same CLI from source.

| Command | Purpose |
|---|---|
| `studio-agent pair --server <url> --code <code> [--name <name>]` | Pair this Mac with a server |
| `studio-agent run [--log-level debug\|info\|warn\|error]` | Connect and run jobs until stopped |
| `studio-agent status` | Show the configuration; the device token is redacted |
| `studio-agent service install\|uninstall\|status` | Manage the launchd agent |

## Pairing

1. In the web app, open Settings → Devices and create a pairing code (`XXXX-XXXX`, valid for 10 minutes, single use).
2. On the Mac:

   ```bash
   pnpm --filter @loomcast/studio-agent build
   pnpm agent pair --server https://loomcast.example.com --code ABCD-EFGH --name "Studio Mac"
   ```

The agent calls `POST /api/bridge/pair` and stores the result in `~/.config/loomcast-agent/config.json`. The directory is mode 0700 and the file 0600:

```json
{
  "serverUrl": "https://loomcast.example.com",
  "deviceId": "…",
  "token": "lc_dev_…",
  "workspaceRoot": "/Users/me/Loomcast",
  "concurrency": { "producer": 1, "render": 1 }
}
```

- The server URL must use `https`. Plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, so the token never travels unencrypted.
- Pairing again replaces the device id and token but keeps `workspaceRoot` and `concurrency`.
- `LOOMCAST_AGENT_HOME` moves the whole state directory (used by tests and for running a second agent).

## Running

```bash
pnpm agent run                      # from source
node apps/studio-agent/dist/cli.mjs run
```

The agent logs to stderr. On each connection it sends `hello` with the job types it can run, its free credits per concurrency class and the jobs it still has to report (`resume`).

| Situation | What the agent does |
|---|---|
| Connection lost | Reconnects with full-jitter backoff from 1 s up to 60 s; the backoff resets after 60 s of stable connection |
| No ping from the server for 60 s | Drops the socket and reconnects |
| Close 4401 or 4403, or HTTP 401/403 on upgrade | Logs "re-pair required" and exits; run `pair` again |
| Close 4409 (another connection of this device took over) | Exits |
| Close 4426 (unsupported protocol) | Exits; update the agent |
| `SIGINT` or `SIGTERM` | Fails running jobs as `interrupted` (retryable) and exits |

All of these exits use code 0. Restarting would only repeat the refusal, so launchd does not restart the agent after them.

### Job state

The state directory also holds:

- `outbox/<jobId>.jsonl`: the durable events of each unsettled job. Events are written here before they are sent, replayed after a reconnect, and trimmed when the server acks them. The file is deleted once every event is acked and the job's outcome has been sent.
- `journal.jsonl`: the outcome of every finished job, kept for 7 days. If the server assigns a job that already finished, the agent answers from the journal instead of running it again.

Jobs that were running when the agent stopped are reported as `interrupted` on the next connection.

### Jobs

| Job type | Handler |
|---|---|
| `system.ping` | Reports the agent version, the Node runtime and whether the producer is available |
| `producer.chat` | Added with the producer runtime; until then it is not advertised and assignments are rejected |

Handlers are registered in `src/jobs/index.ts`. The runner validates every payload and result against the contracts job registry, rejects unknown job types, enforces the per-class credits and the registry timeout, and aborts a job on `job.cancel`.

## launchd service

```bash
pnpm --filter @loomcast/studio-agent build
pnpm agent service install     # writes the plist and loads it
pnpm agent service status
pnpm agent service uninstall
```

`service install` requires a paired agent. It writes `~/Library/LaunchAgents/com.loomcast.studio-agent.plist`, which:

- runs `<absolute node path> <absolute path of dist/cli.mjs> run`;
- starts at login (`RunAtLoad`) and restarts the agent after a crash (`KeepAlive` with `SuccessfulExit = false`);
- logs to `~/Library/Logs/Loomcast/studio-agent.log`.

The plist is loaded with `launchctl bootstrap gui/$UID`. Running `service install` again reloads it, which is also how to restart the agent after pairing again or rebuilding. `service uninstall` unloads it with `launchctl bootout` and deletes the plist; logs are kept.

## Development

```bash
pnpm --filter @loomcast/studio-agent test
pnpm --filter @loomcast/studio-agent typecheck
pnpm --filter @loomcast/studio-agent build
```

The tests run against an in-process fake bridge server built from the contracts schemas and need no network access.
