# M3 acceptance: the first real render on the Mac

Milestone 3 is done when, on the Mac, an idea in a real format goes through script, storyboard,
voice and render via the studio agent; the review screen plays the result; a request for changes
produces a revised version; approval works; and every version is kept. This runbook prepares the
Mac for that first real render (owner checkpoint C6) and walks through the sign-off.

`pnpm test:e2e` already checks the same flow with a fake studio agent and synthetic media. This
run is the one with the producer runtime, the TTS provider and a real render, so it costs
provider credits and a few minutes per pass.

> **Owner checkpoint C6.** The owner sets the TTS provider key and chooses a default voice ID,
> installs ffmpeg and a render browser (checked with `hyperframes doctor`, telemetry off), and
> signs off the first real render below.

Keys never go into this repository, a chat, an issue or shell history. Paste them at the hidden
prompts shown here.

## 1. The local system

Follow the [local development guide](../local-development.md) up to a running system:

```bash
pnpm install
pnpm stack:up && pnpm db:migrate     # Postgres and object storage (SeaweedFS with its buckets)
pnpm dev                             # API and web app on http://localhost:5173
```

Sign in, then pair the studio agent (**Settings → Devices → Pair a device**) and start it with
`pnpm agent run`. The producer runtime must be signed in on the Mac: a chat message in a
project's **Chat** tab should get a reply.

## 2. Render tools

Set the telemetry variables in the shell first; every HyperFrames command below runs the
studio's pinned CLI through pnpm, never through `npx`:

```bash
export HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1 HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_AUTO_INSTALL=1
```

1. **ffmpeg and ffprobe.** `ffmpeg -version` and `ffprobe -version` must work. If they do not,
   install ffmpeg (for example `brew install ffmpeg`).
2. **A render browser.** `pnpm --filter @loomcast/studio exec hyperframes browser path` prints the
   Chrome the renderer will use. If it finds none, either point `HYPERFRAMES_BROWSER_PATH` at an
   installed Chrome or headless shell (set it in the agent's environment, too), or let the CLI
   download its headless shell once with `pnpm --filter @loomcast/studio exec hyperframes browser
   ensure` (about 200 MB into `~/.cache/hyperframes/chrome/`). Nothing downloads a browser on its
   own.
3. **Doctor.** `pnpm --filter @loomcast/studio exec hyperframes doctor` reports the system
   dependencies; fix anything it marks as missing.
4. **Smoke render.** `pnpm --filter @loomcast/studio test:smoke` renders five seconds of a
   library card over a synthetic tone and checks the MP4 (1080×1920, the tone's length). It must
   pass, not be skipped; a skip names the missing tool.

## 3. The TTS provider key and a voice

1. Store the key for the studio agent (hidden prompt, or pipe it from the clipboard):

   ```bash
   pnpm agent secrets set voice-provider-key
   pnpm agent status        # "Voice provider key: set"
   ```

   It is kept in `~/.config/loomcast-agent/secrets.env` (mode 0600). Restart `pnpm agent run`
   afterwards so the running agent sees it.
2. Choose the default voice in the TTS provider's voice library and note its voice ID. It goes
   into the format in step 5; it is not a secret.

## 4. Skills

Publish the studio's skills so producer steps load the current versions:

```bash
pnpm --filter @loomcast/api run skills:seed -- ../../studio/skills
```

The command reads `DATABASE_URL` from `.env`. Publishing queues a `skills.sync` job; with the
agent running, `~/Loomcast/skills/manifest.json` lists `scriptwriting`, `storyboarding`,
`captions-and-pacing`, `revision` and `vertical-explainer` shortly after. Running it again with
unchanged files publishes nothing new.

## 5. The acceptance run

1. **Series and format.** In a project's **Series** tab choose **New series**, name it and keep
   "New format with default rules". In the format editor set:
   - **Voice ID**: the voice from step 3 (and **Speed** if wanted);
   - **Length**: for example 30 to 45 seconds;
   - **Style**: `vox-explainer` (the default) or another style of the library;
   - tone, hook style and topics to taste.

   **Save version**. The version history shows version 2.
2. **Idea.** On the series page choose **New idea**, give it a title and a pitch, and **Add
   idea**.
3. **Produce.** In the project's **Content** tab, open the idea's actions menu and choose
   **Produce through review** (or **Produce** on its page). On the item page the job banner shows
   each step: script, storyboard (producer sessions), voice and render (the studio runtime, with
   progress every 10%). The item reaches **In review** with version 5.
4. **Review.** Open **Review** in the sidebar and the item from the queue. Check:
   - **Video** plays the render with sound (it never autoplays), with the poster, 1080 × 1920 and
     a length within the format's range (a note on the version says when it is not);
   - **Script** shows the segments with their spoken timestamps;
   - **Storyboard** shows the cards, their slots and timing bars;
   - **Voice** plays the take.
5. **Request changes.** In the Review panel write what should change, keep **Ask the producer to
   revise** ticked and choose **Request changes**. A `content.revise` job runs with the comment,
   followed by storyboard, voice and render; the item is back in review at version 9. Compare the
   two scripts from the version timeline.
6. **Approve.** From the review queue open the item again and **Approve**. The item shows
   **Approved**, the queue no longer lists it, and the version timeline still has versions 1 to 9;
   the voice tab lists both takes.

## 6. Sign-off

| Check | Result |
|---|---|
| `test:smoke` passed on the Mac | |
| `pnpm agent status` shows the voice provider key as set | |
| An idea in a real format reached review through script, storyboard, voice and render | |
| The review screen played the render with sound | |
| A request for changes produced a revised version that came back to review | |
| Approval moved the item to Approved | |
| Every version (1 to 9) and both voice takes are kept | |
| `pnpm test:e2e` is green | |

Record the date, the item and the render length in the milestone notes.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The item stops at storyboard with "Choose a voice in the format" | The format has no voice ID (`voice_not_configured`). Set it in the format editor and produce again |
| The voice step fails with `voice_provider_key_missing` | Step 3: set the key, then restart the agent |
| The voice step fails with `voice_provider_failed` | The provider refused the key or the voice ID, or the account has no credits; the item's last error has the provider's message |
| The render fails with `render_tools_missing` | Step 2: ffmpeg, ffprobe or the render browser is missing |
| The render fails with `frame_too_long`, `frame_too_short` or `beyond_voice` | The storyboard did not fit its cards after it was re-timed to the voice. Request changes asking for a different storyboard, or produce again |
| Script or storyboard jobs fail as signed out | The producer runtime on the Mac is signed out. Sign it in and produce again |
| Jobs stay queued | The agent is offline, or busy with another job of the same class (one producer job and one render job at a time). Check **Settings → Devices** and the agent's log |
| Uploads fail with `transfer_failed` | The object store is not reachable: `docker compose ps` should show `s3` healthy |

More detail: [pipeline](../pipeline.md), [studio runtime](../studio-runtime.md) and the
[studio agent README](../../apps/studio-agent/README.md).
