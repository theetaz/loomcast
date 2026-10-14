# Competitor research

A project follows competitors' profiles. A scan picks a competitor's most popular videos, analyses
each one on the studio agent (download, transcript, frames, analysis), then writes one report into
the project's knowledge base. Producer sessions find the analyses and reports with `kb.search` like
any other entry, so later scripts, formats and new pages can build on them.

The feature is for internal research. Downloaded videos stay on the studio agent's Mac only for the
length of one analysis and are deleted afterwards; Loomcast keeps the transcript, the measured
numbers and the analysis, never the video.

## Flow

1. **Follow.** A user pastes a profile link (`instagram.com/<handle>`, `facebook.com/<page>`,
   `threads.net/@<handle>`) or `@handle` (Instagram). `parseCompetitorUrl` reads the platform and
   the handle; nothing is fetched. One live competitor per project, platform and handle.
2. **Scan.** `POST /api/competitors/:id/scans` with `topN` (1 to 20, default 10) and optional
   `links`.
   - **Official API (`official_api`).** Instagram without `links`: the API server calls the
     Instagram Graph API's Business Discovery on the competitor's handle with the token of an
     active Instagram channel. It reads up to 200 recent posts (pages of 50), keeps Reels and other
     videos, ranks them by `view_count` (then likes plus comments), and picks the top `topN`. It
     also stores the account's name, followers and post count on the competitor. Business
     Discovery only answers for business and creator accounts; any other account is
     `422 not_professional_account`, and the user pastes links instead.
   - **Links (`links`).** Facebook and Threads always, Instagram optionally: exactly the pasted
     links, in the order given. Each must pass `isPublicVideoUrl` for the competitor's platform.
3. **References.** Each picked video becomes a `reference` entry of the project, tagged
   `competitor` and `competitorTag(platform, handle)` (for example `competitor-ig-nasa`). The
   reference URL is the video's permalink, so the knowledge base's per-URL dedupe makes a video
   picked again reuse its entry. A row in `competitor_scan_videos` records the rank and the numbers
   at scan time.
4. **Analyses.** For each reference without a finished analysis, the server queues
   `kb.analyze_reference` with `fetchPublicVideo: true`. A reference already analysed (`done`) is
   reused without a new job. The scan is `analyzing`.
5. **Report.** When every video's analysis has finished or failed, and at least one succeeded, the
   server queues `kb.competitor_report` with the competitor, each analysed video's numbers,
   caption, analysis and summary, and the count of failed videos. The scan is `reporting`. When
   none succeeded, the scan is `failed`.
6. **Done.** The report becomes a `note` entry titled `Competitor report: @<handle> (<date>)`,
   tagged `competitor`, `competitorTag(platform, handle)` and `competitor-report`. Its body is the
   report's markdown followed by the structured insights; `scan.reportEntryId` points at it. The
   scan is `done`, or `partial` when some videos failed.

Only one scan of a competitor is active at a time (`409 scan_in_progress`). Cancelling a scan
cancels its queued and running jobs and marks it `cancelled`; finished analyses stay on their
references.

## Studio agent: fetching a public video

`kb.analyze_reference` with `fetchPublicVideo` runs these steps outside the producer session:

1. **Check the link again.** `isPublicVideoUrl(url, platform)` must hold, or the job fails with
   `invalid_payload`. The producer session never sees or fetches the link.
2. **Download** with `yt-dlp`, spawned directly (no shell), with a fixed argument list:
   `--ignore-config --no-playlist --no-cache-dir --no-mtime --no-write-info-json
   --no-write-thumbnail --no-write-subs --max-filesize 300M --match-filter "duration <=? 600"
   --format "best[ext=mp4][height<=1920]/best[height<=1920]/best" --output <dir>/video.%(ext)s
   -- <url>`. The `<=?` lets a video without a reported duration through (Instagram reports
   none); step 3 checks the length of the file either way. No cookies or browser profiles are
   passed: only public videos are fetched, so the owner's accounts are never at risk. The child
   gets a minimal environment (`PATH`, `HOME`, `LANG` and proxy variables), a 5-minute limit and
   the job's abort signal. The `yt-dlp` path comes from the agent config (`ytDlpPath`, default
   `yt-dlp` on `PATH`); a missing binary fails with `downloader_missing`, not retryable.
3. **Verify** with `ffprobe`: at most 300 MB and 10 minutes, with a video stream.
4. **Measure.** The duration, the cuts per minute from ffmpeg's scene detector
   (`select='gt(scene,0.3)'`), and six evenly spaced frames scaled to 540 px wide as JPEG.
5. **Transcribe** the audio with the existing speech-to-text path. A video without speech is not a
   failure: the analysis then works from the frames and the caption-free facts alone.
6. **Analyse** in the usual read-only session. The prompt carries the transcript (untrusted), the
   measured facts (trusted, computed by the agent) and the frame paths, which the session may open
   with `Read`. Words per minute is the transcript's word count over the duration.
7. **Clean up.** The video and the frames are deleted in a `finally` block, whatever the outcome;
   only `transcript.txt` stays in the project workspace.

The result carries `media` (`ReferenceMediaFacts`) so the server and the report see the measured
numbers, not a guess.

## Studio agent: the report

`kb.competitor_report` runs a read-only session (Read, Glob, Grep, and the read-only MCP tools).
The payload's captions, analyses and summaries come from the competitor and are wrapped as
untrusted data. The session must reply with one fenced JSON block matching
`CompetitorInsightsSchema`, then the report in markdown. One repair turn is allowed, as for
reference analyses.

## Security

- **No server-side fetching of user links.** The API server calls only the Graph API host, with a
  handle that passed `COMPETITOR_HANDLE_RE`. Video links are fetched only by the studio agent,
  only after `isPublicVideoUrl` (on the server when the job is queued, and again on the agent).
- **Tokens stay on the server.** The Instagram channel token used for Business Discovery is read
  from the vault on the API server and never put in a job payload. The agent gets only a job token,
  read-only, bound to the project.
- **Untrusted content stays data.** Captions, transcripts and analyses are wrapped in
  untrusted-data blocks. Analysis and report sessions cannot write files, fetch the web, run
  commands or change the knowledge base; their reply is validated against a schema with bounded
  strings and lists before the server stores it.
- **Bounded downloads.** One public video per job, capped in size, length and time, written to the
  job's own directory inside the project workspace and deleted afterwards. Nothing downloaded is
  ever executed; `yt-dlp` runs without a shell, config files, cookies or post-processing hooks.
- **Bounded work.** At most 20 videos per scan, one active scan per competitor, 50 competitors per
  project.

## Limits and terms

- Business Discovery works for the app's own users (people with a role on the Meta app), which
  covers internal use without app review. It returns view counts for Reels, likes, comments,
  captions and permalinks, but never the video files of Reels.
- Downloading public videos with `yt-dlp` is outside the platforms' terms of use. Loomcast limits
  it to a few public videos per scan, for internal analysis, never stores or republishes them, and
  never uses an account's login to do it.
- Facebook Pages' and Threads profiles' own post lists need permissions the app does not have
  (Page Public Content Access, or none for Threads), so those scans take pasted links.
