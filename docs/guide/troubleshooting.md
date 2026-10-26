# Troubleshooting

When something does not work, find the symptom below, run the checks in order and apply the fix. Most problems come from the studio agent on the Mac, so start with its log. Commands run in the repository folder on the Mac unless the section says otherwise.

## First checks

Three commands answer most questions about the studio agent:

```bash
pnpm agent service status
pnpm agent status
tail -n 50 ~/Library/Logs/Loomcast/studio-agent.log
```

- `service status` says whether the background service is installed and running (`Service: loaded, state running`).
- `status` says whether the Mac is paired, which server it talks to and whether the voice provider key is set.
- The log shows what the agent did, one line per event, with the time in UTC. Lines with `error` or `warn` after the time are the interesting ones.

In the web app, the pill in the top bar shows **Studio online**, **Studio offline** or **No studio**. Select it to open **Account settings → Devices**.

## The studio agent

### The device is Offline or the top bar says Studio offline

**Offline** with **Last seen** **Never** means the Mac was paired but the agent has never connected. **Offline** with a time means it was connected and stopped. Jobs wait until it comes back.

1. Run `pnpm agent service status`.
   - `not installed` or `Service: not loaded`: the agent is not running. Build and install it:

     ```bash
     pnpm --filter @loomcast/studio-agent build
     pnpm agent service install
     ```

   - `loaded, state running`: go to the next step.
   - Loaded but not running, with a `Last exit code`: read the log (next step).
2. Read the log: `tail -n 50 ~/Library/Logs/Loomcast/studio-agent.log`.
   - `connected to the bridge`: the agent is connected. Reload the web app.
   - `the server refused this device; re-pair required`: the device was revoked, or its token no longer works. The agent has stopped and will not restart by itself. Pair again (below).
   - `another connection of this device replaced this one; exiting`: the same device connected twice, usually `pnpm agent run` in a terminal while the service was running. Stop the foreground one and run `pnpm agent service install`.
   - `the server does not support this agent's protocol; update it`: pull the latest code, rebuild and reinstall (see [Keeping it up to date](studio-agent.md#keeping-it-up-to-date)).
   - `bridge connection closed; reconnecting` again and again: the agent cannot reach the server. Check the Mac's network and that your Loomcast address opens in a browser. If the server is down, the owner checks it (see [Server-side checks](#server-side-checks-for-the-owner)).
   - No new lines at all: the service may be starting from a repository on an external drive that is not mounted. Mount it and run `pnpm agent service install`.
3. Run `pnpm agent status`. `Status: not paired` means there is no configuration on this Mac: pair it.

To pair again:

1. In **Account settings → Devices**, select **Pair a device** and copy the command.
2. On the Mac, run it: `pnpm agent pair --server https://loomcast.example.com --code <code>`.
3. Restart the service: `pnpm agent service install`.
4. Revoke the old entry for this Mac in **Account settings → Devices** if it is still listed.

The full setup is in [Setting up the studio agent](studio-agent.md).

### Jobs stay queued

A job banner that keeps saying **Waiting for the studio agent to pick it up.** means no connected agent has taken the job.

1. Check the top bar. If it says **Studio offline**, fix that first (above).
2. Check whether another job is running. By default the agent runs one producer job (script, storyboard, revision, chat, research) and one render job (voice, render) at a time. The next job of the same kind starts when the current one ends. A competitor scan queues many analyses, so other producer jobs wait behind it.
3. If only some job types stay queued while the device is **Online**, the agent may not offer them. Look in the log for `job handler unavailable; not advertising it`, with the job type and the reason. Voice and render need the studio runtime (`pnpm install` in the repository); chat and script work need the producer runtime.

You can raise `concurrency` in the agent's configuration (see [Configuration](studio-agent.md#configuration)), but one of each is the safe default for a single Mac.

### A job failed

1. Open the item. A red banner shows which step failed, when, the reason and a short error code (for example `voice_provider_key_missing`). Competitor scans show **The scan failed** or **Some videos couldn't be analysed** on the scan page, with the reason.
2. Look up the code on this page or in the [studio runtime troubleshooting table](../studio-runtime.md#troubleshooting).
3. For more detail, search the agent log around that time for `job handler failed` or `job finished`:

   ```bash
   grep -E 'job handler failed|job finished|rejecting job' ~/Library/Logs/Loomcast/studio-agent.log | tail -n 20
   ```

4. Fix the cause, then run the step again from the item. See [Videos and review](videos-and-review.md).

A job that was running when the agent stopped or the Mac went to sleep is reported as `interrupted`, and the server tries it again where it can.

### Voice or transcription fails

| Code or message | Cause | Fix |
|---|---|---|
| `voice_provider_key_missing`, or "No TTS provider key is set on this Mac" | The voice provider key is not stored on the Mac that ran the job | `pnpm agent secrets set voice-provider-key`, then check `pnpm agent status` says `Voice provider key: set` |
| `voice_provider_failed` | The voice provider (ElevenLabs) refused the request: a wrong key, an unknown voice ID or no credits | The message says which. Fix the key, the format's **Voice ID**, or your credits with the provider |
| `voice_not_configured` | The format has no voice | Paste the provider's voice ID into **Voice ID** in the format editor ([Series and formats](series-and-formats.md)) |

With more than one Mac paired, store the key on each of them.

### Renders fail

| Code | Cause | Fix |
|---|---|---|
| `render_tools_missing` | ffmpeg, ffprobe, the studio's dependencies or the render browser is missing | Install ffmpeg (for example `brew install ffmpeg`), run `pnpm install`, and follow [Studio runtime](../studio-runtime.md#requirements) |
| `frame_too_long`, `frame_too_short`, `beyond_voice` | The storyboard does not fit its cards or the voice | Request changes on the storyboard, or revise it, then render again |
| `transfer_failed` | The upload to storage failed | Usually passes on retry. If it keeps failing, the owner checks the server's storage (see [Server-side checks](#server-side-checks-for-the-owner)) |

### Producer session errors

Scripts, storyboards, revisions, chat and research analyses run in a producer session on the Mac.

| Code | Cause | Fix |
|---|---|---|
| `producer_not_authenticated` ("Log in to the producer runtime on this Mac") | The producer runtime on the Mac is not signed in | Sign in to the producer runtime on that Mac, as the same macOS user that runs the agent, then retry |
| `producer_account_unavailable` | The producer runtime's account cannot be used right now | Check the account's status and limits, then retry later |
| `producer_unavailable` or `producer_failed` | The producer runtime could not start or the turn failed | Read the agent log for the reason; check that the runtime is installed and that `pnpm install` has run |

If chat messages stay queued while the device is **Online**, the producer runtime may have failed to load: look for `job handler unavailable; not advertising it` with `producer.chat` in the log.

## Competitor research

### A competitor video fails with downloader_missing

The agent could not find yt-dlp. It works in your terminal but not in the service when yt-dlp is installed through pyenv, pipx or asdf, because the service only looks in a few fixed folders.

1. Check: `which yt-dlp`. If the path is not in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` or `/bin`, the service cannot see it.
2. Fix it one of two ways:
   - install it with Homebrew: `brew install yt-dlp`; or
   - set `ytDlpPath` in `~/.config/loomcast-agent/config.json` to the real program (for pyenv, `pyenv which yt-dlp` prints it). Use a full path, not a shim.
3. Restart the service: `pnpm agent service install`.
4. Scan again.

Step by step: [Tools the service cannot find](studio-agent.md#tools-the-service-cannot-find).

### Other video errors

| Code | Cause | Fix |
|---|---|---|
| `video_too_long` | The video is longer than 10 minutes | Not supported; pick shorter videos |
| `video_too_large` | The video is larger than 300 MB | Not supported |
| `download_failed` | The platform refused the download: a private or removed video, a login wall or a rate limit. Network errors are retried | Read the reason in the message. Private videos cannot be analysed; for rate limits, try again later |
| `transcript_empty` | The video has no speech | Nothing to fix |

More in [Competitor research](competitor-research.md) and the [technical notes](../competitor-research.md).

## Publishing

### A post failed or did not go out

1. Open the post's workspace, then **Workspace settings → Channels**, and look at the channel.
   - **Needs reconnect**: the platform no longer accepts the stored sign-in (an expired token, a changed password, a removed Page role). Select **Reconnect** in its banner and sign in again with the account that has the Page or profile. Its posts fail with an `auth` error until you do.
   - **Dry run** switched on: the post was recorded, not sent. Dry-run posts get a link that never opens. Turn **Dry run** off when you are ready to publish for real (type `publish live` to confirm).
   - A red notice on the channel shows the platform's last error.
2. Open **Account settings → Scheduler** (owner and admins). Failed and dead tasks of every workspace are listed with their last error and a **Retry** button. Fix the cause first, then select **Retry**.
3. If every post is held back and the channel switch cannot be turned off, the server itself may be in dry-run or publishing may be paused. That is a server setting: see [Deploying and running the server](operations.md).

The full rules are in [Publishing](publishing.md) and the [technical notes](../scheduling-and-publishing.md).

### Instagram will not connect

See [Instagram account won't connect](publishing.md#instagram-account-wont-connect).

## Signing in

### I can't sign in

Loomcast is invite-only. There is no sign-up and no self-service "forgot password" link.

- Check that you use the email address your invitation was sent to.
- If you have forgotten your password, ask the owner for a new password link.
- If your access was disabled, only the owner can restore it.

### The set-password link has expired or was already used

The page says **This link has expired or was already used**. Each link works once. Invitation links last 7 days and reset links 24 hours.

Ask the owner for a new link. The owner opens **Account settings → Members**, opens the member's menu and selects **New password link**, then sends you the link. See [Settings](settings.md).

## Server-side checks for the owner

When everyone sees errors, pages do not load, or the agent cannot connect from any Mac, check the server:

1. Open `https://loomcast.example.com/readyz`. `{"status":"ok", …}` means the server, database, storage and scheduler are fine. A `503` with one check not `ok` points at the cause.
2. Signed in as the owner, open `https://loomcast.example.com/api/ops/status` for the version, readiness details, scheduler and last backup.
3. Look at the latest deploy in GitHub Actions. A deploy that failed its checks rolls back by itself.

Logs, restarts and rollbacks are in [Deploying and running the server](operations.md).

## What to start and stop

| Task | Where | Command or place |
|---|---|---|
| Start the studio agent (and keep it running) | Mac | `pnpm agent service install` |
| Restart the studio agent | Mac | `pnpm agent service install` (again) |
| Stop the studio agent | Mac | `pnpm agent service uninstall` |
| Is the studio agent running? | Mac | `pnpm agent service status` |
| Run the agent in a terminal to debug | Mac | `pnpm agent run` (uninstall the service first) |
| Disconnect a Mac for good | Web app | **Account settings → Devices**, **Revoke** |
| Stop one channel publishing live | Web app | **Workspace settings → Channels**, turn **Dry run** on |
| Restart, roll back or pause the server | Server | See [Deploying and running the server](operations.md) |

## Collecting information for a bug report

Gather this before you report a problem:

1. **What you did and what you expected**, and the page you were on (copy its address from the browser).
2. **The time** it happened, with your time zone. The agent log uses UTC.
3. **The error** exactly as shown: the banner text and its code.
4. **The agent version**: `pnpm agent --version`.
5. **The agent's state**: the output of `pnpm agent service status` and `pnpm agent status`.
6. **The agent log** around that time:

   ```bash
   tail -n 200 ~/Library/Logs/Loomcast/studio-agent.log
   ```

Never paste tokens, keys or passwords into a report. `pnpm agent status` already hides the device token as `[redacted]` and the agent never logs the voice key, but check what you paste anyway. Do not share `config.json`, `secrets.env` or server env files, and replace your Loomcast address and account names if the report is public.
