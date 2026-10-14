# Studio runtime

Videos are rendered on the owner's Mac, not on the server. The studio agent runs the voice and
render jobs of the [production pipeline](pipeline.md) with the studio runtime in `studio/runtime`
(exported as `@loomcast/studio/runtime`), and uploads the results to object storage. This guide
covers what the Mac needs, where the TTS provider key goes, how a render is made and how to check
it without the rest of the system.

## What runs where

| Step | Done by | Needs on the Mac |
|---|---|---|
| Script, storyboard, revision | A producer session started by the studio agent | The producer runtime, signed in |
| Voice | The studio runtime calling the TTS provider | The TTS provider key, ffmpeg and ffprobe |
| Render | The studio runtime driving HyperFrames and ffmpeg | ffmpeg, ffprobe, a render browser, the studio's installed dependencies |
| Upload | The studio agent, through presigned PUTs | Network access to the object store |

Renders are never produced by a producer session: the voice and render jobs call the runtime
directly. Producer sessions in storyboard jobs may only run `hyperframes lint` and `ffprobe` on
files of their own item (see the [studio agent README](../apps/studio-agent/README.md#commands-in-storyboard-sessions)).

## Requirements

- **The repository with its dependencies installed** (`pnpm install`). The studio agent finds the
  `studio/` folder by walking up from itself; set `LOOMCAST_STUDIO_ROOT` when it runs from
  elsewhere. HyperFrames and GSAP are pinned in `studio/package.json`; the runtime runs the pinned
  CLI (`studio/node_modules/hyperframes/bin/hyperframes.mjs`) with node, never through `npx`.
- **ffmpeg and ffprobe** on the `PATH` (for example from Homebrew). They encode the delivered
  MP4, mix and measure the voice, and probe every upload.
- **A render browser.** HyperFrames renders in headless Chrome. The runtime uses
  `HYPERFRAMES_BROWSER_PATH` when it is set, and otherwise a Chrome headless shell already in the
  CLI's cache (`~/.cache/hyperframes/chrome/`). It never downloads a browser; installing one is a
  deliberate step (see the [M3 acceptance runbook](runbooks/m3-acceptance.md)).
- **The TTS provider key**, for voice jobs and for transcribing reference media (below).
- **yt-dlp**, only for [competitor research](competitor-research.md) (for example
  `brew install yt-dlp`). The agent runs `yt-dlp` from the `PATH`, or the binary named by
  `ytDlpPath` in `~/.config/loomcast-agent/config.json`. Without it, competitor videos fail with
  `downloader_missing` and everything else keeps working.

## Competitor videos on the Mac

A `kb.analyze_reference` job with `fetchPublicVideo` downloads one public video into
`~/Loomcast/projects/<projectId>/references/<entryId>/media-<jobId>/` (mode 0700). `yt-dlp` runs
without a shell, config files, cookies or post-processing hooks, with only `PATH`, `HOME`, `LANG`
and the proxy variables in its environment, and is stopped after 5 minutes. ffprobe checks the
file (one file, at most 300 MB and 10 minutes, with a video stream); ffmpeg counts the cuts and
takes six frames, 540 px wide, into `frames/`. The audio is transcribed with the TTS provider key.

The analysis session may open the frames with `Read`; it never sees the link. When the job ends,
whatever the outcome, the `media-<jobId>/` folder with the video and the frames is deleted. Only
`references/<entryId>/transcript.txt` stays (none for a video without speech).

## Telemetry off

Every command the runtime spawns gets `HYPERFRAMES_NO_TELEMETRY=1` and `DO_NOT_TRACK=1`, and the
HyperFrames update check and self-install are turned off (`HYPERFRAMES_NO_UPDATE_CHECK=1`,
`HYPERFRAMES_NO_AUTO_INSTALL=1`). Set the same variables yourself before running any HyperFrames
command by hand:

```bash
export HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1 HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_AUTO_INSTALL=1
pnpm --filter @loomcast/studio exec hyperframes doctor        # system dependencies
pnpm --filter @loomcast/studio exec hyperframes browser path  # the browser renders would use
```

`pnpm --filter @loomcast/studio exec hyperframes …` runs the pinned CLI; it is the safe form of
`npx hyperframes …`, which could fetch another version. Never run `hyperframes init`, `upgrade`,
`skills update` or `feedback` without review.

## The TTS provider key

The studio agent reads the key when a voice or transcription job runs, in this order:

1. its private secrets file, `~/.config/loomcast-agent/secrets.env` (mode 0600), set with

   ```bash
   pnpm agent secrets set voice-provider-key    # hidden prompt, or pipe the key on stdin
   pnpm agent status                            # says whether it is set, never the value
   ```

2. the environment of the agent;
3. `studio/.env`, under the provider key variable listed in `studio/.env.example`.

The first is the one to use on the Mac. The key is never taken from the command line and never
goes into a job payload, a result, an event, the outbox, the journal or a log line. Without it,
voice jobs fail with `voice_provider_key_missing`. `studio/.env` is git-ignored; never commit it.

The voice itself is chosen per format: paste the provider's voice ID into **Voice ID** in the
format editor. Without one, production stops before the voice step (`voice_not_configured`).

## How a version is rendered

A job works in the folder of the version it starts from:

```text
~/Loomcast/projects/<projectId>/items/<itemId>/v<n>/
  script.json  storyboard.json  voice.mp3  alignment.json  render/  out/final.mp4  poster.jpg
```

1. **Voice.** The script's segments are sent to the TTS provider's timestamped endpoint, in parts
   of at most 5,000 characters split at segment boundaries; parts are joined with ffmpeg and their
   word timings offset. 429 and 5xx answers are retried. The take is probed and uploaded as a
   `voice` asset with its alignment; the server then times the script and re-times the storyboard
   to it ([timing after the voice](pipeline.md#timing-after-the-voice)).
2. **Validation.** The storyboard is checked against `studio/style-library/registry.json` and each
   style's `style.json`: known cards, declared slots within their character limits, frames in
   order without overlaps, each frame within its card's length limits, and nothing past the voice.
3. **Assembly.** A HyperFrames project is written to `render/`. Shorts are 1080×1920: the vertical
   shell (`studio/runtime/templates/vertical-shell/`) has a hook band, a card area and a caption
   band. Landscape library cards are mounted as sub-compositions scaled to the frame width; 9:16
   cards fill the frame. Slot text is HTML-escaped. Captions come from the voice timings: at most
   3 words or 18 characters a line, 2 lines, and at least 0.6 s on screen.
4. **Render.** `hyperframes lint`, then `hyperframes render`, spawned with argument arrays (never a
   shell string).
5. **Encode and check.** ffmpeg muxes the voice when needed, normalises loudness to −14 LUFS and
   encodes H.264 High, yuv420p, 30 fps, AAC 48 kHz at 128 kb/s with `+faststart`, and takes a
   poster at 1 s. ffprobe then checks 1080×1920 and the voice length ±0.5 s.
6. **Upload.** The video and the poster are hashed while streamed, uploaded with exactly the
   signed headers (including the SHA-256 checksum header) and finalized with their probe.

Progress is reported every 10% (assemble, lint, render, encode, poster, verify) and appears in the
item page's job banner.

## Running the runtime by hand

```bash
pnpm --filter @loomcast/studio run runtime validate path/to/storyboard.json
pnpm --filter @loomcast/studio run runtime assemble path/to/item   # storyboard.json, voice.mp3, alignment.json, script.json
pnpm --filter @loomcast/studio run runtime render path/to/item     # out/final.mp4 and poster.jpg
pnpm --filter @loomcast/studio run runtime probe path/to/file.mp4
```

Use `pnpm … run runtime`: plain `pnpm … runtime` is a pnpm command of its own.

## Checks

| Command | What it does | Needs |
|---|---|---|
| `pnpm --filter @loomcast/studio test` | Unit tests of validation, assembly, captions, the render commands (spawn mocked) and the voice client (fetch mocked); part of `pnpm test` | Nothing; never renders or calls the provider |
| `pnpm --filter @loomcast/studio test:smoke` | Renders five seconds of a library card over a synthetic sine-tone voice made by ffmpeg, then checks the MP4 | ffmpeg, ffprobe, a render browser; skipped with the reason otherwise |
| `HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1 pnpm --filter @loomcast/studio exec tsx runtime/scripts/smoke-render.ts [--keep]` | The same render as a script; `--keep` leaves the output for inspection | The same |
| `LOOMCAST_SMOKE=1 … pnpm --filter @loomcast/studio-agent exec tsx scripts/smoke-production.ts` | Script, storyboard, voice and render for one item of the local stack with the real producer runtime, TTS provider and renderer | Everything above, an access token and an item id; see the script header. It costs provider credits |

`test:smoke` sets `LOOMCAST_SMOKE_RENDER=1` and the telemetry variables itself.

The end-to-end suite (`pnpm test:e2e`) never renders: its fake studio agent uploads synthetic
media in place of voice takes and renders.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| A voice job fails with `voice_provider_key_missing` | Set the key with `pnpm agent secrets set voice-provider-key` and check `pnpm agent status` |
| A competitor video fails with `downloader_missing` | Install yt-dlp (`brew install yt-dlp`), or set `ytDlpPath` in the agent config to its absolute path, and restart the agent |
| A competitor video fails with `download_failed` | The platform refused the download (a private or removed video, a login wall or a rate limit). The message has `yt-dlp`'s reason; retryable network errors are retried once |
| A voice job fails with `voice_provider_failed` | The TTS provider refused the request: a wrong key, an unknown voice ID or no credits. The message says which; 429 and 5xx answers were already retried |
| A render fails with `render_tools_missing` | ffmpeg, ffprobe, the pinned HyperFrames CLI, GSAP or the render browser is missing. Run `hyperframes doctor` and `hyperframes browser path` as above, and `pnpm install` |
| A render fails with `frame_too_long`, `frame_too_short` or `beyond_voice` | The storyboard does not fit its cards or the voice after re-timing. Request changes (or revise the storyboard) and render again |
| The render's ffprobe check fails | The output is not 1080×1920 or does not match the voice length. Keep the smoke output (`--keep`) and inspect `render/` |
| Upload fails with `transfer_failed` | The object store refused the PUT or could not be reached. Locally, check `pnpm stack:up`; in production, the R2 endpoint and its CORS rules |
| Voice and render jobs stay queued while the device is online | The agent advertises a job type only when its handler loads, and these load the studio runtime. Check the agent's log, `LOOMCAST_STUDIO_ROOT` and `pnpm install` |
