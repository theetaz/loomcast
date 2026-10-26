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
| `studio-agent secrets set\|unset voice-provider-key` | Store or remove the TTS provider key |

## Pairing

1. In the web app, open Account settings → Devices and create a pairing code (`XXXX-XXXX`, valid for 10 minutes, single use).
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
- Pairing again replaces the device id and token but keeps `workspaceRoot`, `concurrency` and `ytDlpPath`.
- `ytDlpPath` (optional, added by hand) is the `yt-dlp` binary used for competitor research: an absolute path, or a name looked up on `PATH`. It defaults to `yt-dlp`.
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
| `producer.chat` | Runs one conversation turn in a producer session confined to the workspace folder, resuming the previous session when it exists and streaming text and tool activity back. If the producer runtime fails to load, the job type is not advertised |
| `kb.analyze_reference` | Analyses a saved reference from its transcript in a new, read-only producer session and returns a schema-checked analysis with a short summary. The transcript is written to `references/<entryId>/transcript.txt` in the workspace folder; the reference URL is never fetched. A reference with uploaded media and no transcript is transcribed first (see below) and the result carries the transcript. With `fetchPublicVideo` (competitor research), the agent itself downloads the public video, measures and transcribes it, and the session also gets the measured facts and six frames (see below) |
| `kb.competitor_report` | Writes one report on a competitor from the analyses of its top videos in a new, read-only producer session, and returns schema-checked insights with the markdown report. The competitor's captions, analyses and summaries are sent as untrusted data |
| `content.write_script` | Writes the item's script in a new producer session; the reply must match the script contract |
| `content.storyboard` | Sets the script to cards of the format's style; the reply must pass the studio runtime's storyboard validation |
| `content.revise` | Revises the script or storyboard; the owner's review comment is passed as trusted text |
| `content.voice` | Synthesizes the script with the TTS provider through the studio runtime and uploads the take with its word timings |
| `content.render` | Renders the storyboard over the voice take with the studio runtime and uploads the video and its poster |
| `skills.sync` | Pulls published skills into `~/Loomcast/skills/<name>/` |

### Knowledge-base access

Producer sessions never see the device token. When a job type has MCP access, the server sends a job token (`lc_job_…`) with the assignment; the agent resolves its endpoint against the paired server URL and keeps it in memory for that job only. It is never logged and never written to the outbox, the journal or the config.

The session gets the platform's MCP server (`loomcast`) with that token, and the permission guard allows only the tools of the job type:

| Job type | MCP tools | Built-in tools |
|---|---|---|
| `producer.chat` | `kb.search`, `kb.get`, `kb.save_brainstorm`, `kb.add_decision`, `kb.add_reference`, `workspace.get` | Read, Glob, Grep, Write and Edit in the workspace folder, WebSearch, WebFetch |
| `kb.analyze_reference`, `kb.competitor_report` | `kb.search`, `kb.get`, `workspace.get` | Read, Glob and Grep inside the workspace folder only |
| `content.write_script`, `content.revise` | `content.get`, `format.get_rules`, `kb.search`, `kb.get`, `workspace.get` | Read, Glob and Grep inside the workspace folder only |
| `content.storyboard` | the same | Read, Glob and Grep inside the workspace folder, and the two allow-listed commands |

The producer runtime names MCP tools `mcp__<server>__<tool>` with every character outside `[A-Za-z0-9_-]` replaced by `_`, so `kb.search` appears as `mcp__loomcast__kb_search`. Every other MCP tool and server is denied.

Handlers are registered in `src/jobs/index.ts`. The runner validates every payload and result against the contracts job registry, rejects unknown job types, enforces the per-class credits and the registry timeout, and aborts a job on `job.cancel`.

### Production jobs

Production jobs read the item and write assets through the platform's MCP server with the job token (`content.get`, `content.upload_asset`, `content.finalize_asset`, `asset.get_url`, `skill.pull`). A job works in the folder of the version it starts from:

```
~/Loomcast/projects/<workspaceId>/items/<itemId>/v<n>/
  script.json  storyboard.json  voice.mp3  alignment.json  render/  out/final.mp4  poster.jpg
```

Each workspace works in `~/Loomcast/projects/<workspaceId>` (under `workspaceRoot`). The folder keeps the name `projects` from before projects were renamed workspaces, so existing producer sessions and files keep working. The server still sends each job's workspace as `projectId` too, so an agent built before the rename keeps working until it is updated.

- **Producer steps** (`write_script`, `storyboard`, `revise`) start a new producer session in the workspace folder. The step brief, the format rules, the item's topic and the skill pack are appended to its system prompt. The reply must hold one fenced JSON block; up to two repair turns in the same session get the problems found. The session only reads: the item, the format and the knowledge base through MCP, and files inside the workspace folder.
- **Voice and render** run the studio runtime directly; no producer session takes part, so renders are never produced by a producer session. Progress is reported as `status` events every 10%. Render checks for ffmpeg, ffprobe, the studio's pinned HyperFrames CLI, GSAP and a render browser already on the Mac, and never downloads one.
- **Uploads** are content-addressed: the file is hashed while streamed from disk, `content.upload_asset` gets the size and SHA-256, the bytes are PUT with exactly the signed headers (including the checksum header) and `duplex: "half"`, retried up to 3 attempts on network errors and 408/429/5xx, and the asset is finalized with its probe (and a voice take's word timings). When the server already has an identical file, nothing is sent.
- **Reference media** with no transcript is downloaded from the platform's own storage through `asset.get_url` (checked against its SHA-256), its audio is extracted and transcribed, and the media file is deleted again.
- **Public competitor videos** (`fetchPublicVideo`) are fetched only after `isPublicVideoUrl` holds again on the agent. `yt-dlp` (from `PATH` or `ytDlpPath`) runs without a shell, with a fixed argument list (no config files, cookies, browser profiles or `--exec`), a minimal environment (`PATH`, `HOME`, `LANG`, proxy variables), a 5-minute limit and the job's abort signal, into `references/<entryId>/media-<jobId>/` (mode 0700). ffprobe checks the one file (at most 300 MB and 10 minutes, with a video stream), ffmpeg counts cuts with its scene detector and takes six 540 px frames, and the audio is transcribed; a video without speech is analysed without a transcript. The result carries `media` (duration, cuts and words per minute, frames). The video and the frames are deleted in a `finally` block; only `transcript.txt` stays. A missing `yt-dlp` fails with `downloader_missing`.

The studio runtime is bundled into `dist/` and finds the repository's `studio/` folder by walking up from the agent; `LOOMCAST_STUDIO_ROOT` overrides it.

### Skills

`skills.sync` checks each pulled skill against its checksum, writes it to a staging folder and renames it into place, so a failed sync keeps the installed version. `~/Loomcast/skills/manifest.json` records the synced versions and checksums. Producer steps load each skill from there when its files still match the manifest, and fall back to the studio's bundled `studio/skills/` otherwise.

### Commands in storyboard sessions

Bash is removed from every producer session except `content.storyboard`, where a command guard allows exactly two commands on paths inside the item folder:

- `npx hyperframes lint <folder> [--json]`, run as the studio's pinned CLI with node, never through `npx`;
- `ffprobe -v error [-show_format] [-show_streams] [-show_entries …] [-select_streams …] [-of …] <file>`.

The guard refuses anything a shell would interpret (`; & | $ \` < > ( ) { } [ ] * ? ~ ! #`, quotes, backslashes and line breaks), resolves the path with `realpath` and requires it to stay inside the item folder, then replaces the command with absolute, quoted arguments and the telemetry variables (`HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1 HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_AUTO_INSTALL=1`). Everything else, including `hyperframes render`, is denied with a reason. The guard runs as a `PreToolUse` hook, which fires before the producer runtime's own permission rules, and again as the permission callback.

### TTS provider key

```bash
pbpaste | pnpm agent secrets set voice-provider-key   # or type it at the hidden prompt
pnpm agent secrets unset voice-provider-key
```

The key is stored in `~/.config/loomcast-agent/secrets.env` (mode 0600, in the 0700 state directory) and is never taken from the command line. Voice and transcription jobs read it from there first, then from the environment and the studio's `.env`. It goes to the TTS provider only: never into a payload, a result, an event, the outbox, the journal or a log line. `studio-agent status` only says whether it is set.

### Production smoke test

`scripts/smoke-production.ts` runs script → storyboard → voice → render for one item of the local stack with the real producer runtime, TTS provider and render. It needs `LOOMCAST_SMOKE=1`, `LOOMCAST_SMOKE_TOKEN` (an access token with `mcp:read` and `mcp:write`) and `LOOMCAST_SMOKE_ITEM_ID`; see the header of the script.

## Session-end hook

`hooks/session-end.mjs` is an optional hook for any client that runs a session-end hook with a
JSON payload on stdin. It digests the session transcript, redacts secrets and files the result
in the workspace's knowledge base with the `kb.save_session_summary` MCP tool. It is off by
default, has no dependencies, gives the server 5 seconds and always exits 0.
`hooks/install.mjs` prints the hook entry and its environment, or merges the entry into a JSON
settings file with `--write <file>`. See [docs/session-hook.md](../../docs/session-hook.md).

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
pnpm --filter @loomcast/studio-agent exec vitest run hooks   # the session-end hook only
pnpm --filter @loomcast/studio-agent typecheck
pnpm --filter @loomcast/studio-agent build
```

The tests run against an in-process fake bridge server built from the contracts schemas and need no network access.
