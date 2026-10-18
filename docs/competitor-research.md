# Competitor research

A workspace follows competitors' profiles. A scan picks a competitor's most popular videos, analyses
each one on the studio agent (download, transcript, frames, analysis), then writes one report into
the workspace's knowledge base. Producer sessions find the analyses and reports with `kb.search` like
any other entry, so later scripts, formats and new pages can build on them.

The feature is for internal research. Downloaded videos stay on the studio agent's Mac only for the
length of one analysis and are deleted afterwards; Loomcast keeps the transcript, the measured
numbers and the analysis, never the video.

## Flow

1. **Follow.** A user pastes a profile link (`instagram.com/<handle>`, `facebook.com/<page>`,
   `threads.net/@<handle>`) or `@handle` (Instagram). `parseCompetitorUrl` reads the platform and
   the handle; nothing is fetched. One live competitor per workspace, platform and handle.
2. **Scan.** `POST /api/competitors/:id/scans` with `topN` (1 to 20, default 10) and optional
   `links`.
   - **Official API (`official_api`).** Instagram without `links`: the API server calls the
     Instagram Graph API's Business Discovery on the competitor's handle with the token of an active
     Instagram channel (the workspace's own first, else the first one connected in another workspace:
     the lookup posts nothing). It reads up to 200 recent posts (pages of 50), keeps Reels and other
     videos, ranks them by `view_count` (then likes plus comments), and picks the top `topN`. It
     also stores the account's name, followers and post count on the competitor. Business
     Discovery only answers for business and creator accounts; any other account is
     `422 not_professional_account`, and the user pastes links instead.
   - **Links (`links`).** Facebook and Threads always, Instagram optionally: exactly the pasted
     links, in the order given. Each must pass `isPublicVideoUrl` for the competitor's platform.
3. **References.** Each picked video becomes a `reference` entry of the workspace, tagged
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
references. Deleting a competitor cancels its active scan the same way; its references and
reports stay in the knowledge base.

## API server

The `competitors` module (`apps/api/src/modules/competitors/`) serves the routes of
`packages/contracts/src/api/routes.ts` (`competitors.*`, `competitorScans.*`), all with a session.

- **Errors.** A link that is not a profile is `400 validation_failed` (path `url`); a duplicate is
  `409 conflict` with `reason: "duplicate"`, and a workspace at the limit `reason: "limit"`. Pasted
  links that are not public videos of the competitor's platform are `422 invalid_link`, with one
  `{ path: "links.<n>" }` per bad link. Besides `links_required`, `no_instagram_channel` and
  `not_professional_account`, a scan can be refused with `422 no_videos` (the account has no
  recent video), `502 platform_error` (the Graph API refused the lookup for another reason) and
  `503 not_configured` (no Meta app on the server).
- **Discovery.** `businessDiscovery` (`lib/meta-graph/meta.ts`) goes through the Graph client
  (timeouts, retries, `appsecret_proof`), follows the media cursor, and asks again without
  `view_count` when the API refuses that field; the ranking then falls back to likes plus
  comments. The handle is checked against `COMPETITOR_HANDLE_RE` before it enters the `fields`
  expression, and so is the cursor's alphabet.
- **Starting.** The videos are picked before the transaction (the Graph API call), then one
  transaction stores the account numbers, the scan, a reference per video (the knowledge base's
  `ensureReference`: an existing reference of the URL is reused and gains the competitor tags)
  and its analysis job. A reference whose analysis is already queued or running keeps that job.
  A scan of pasted links stores the number of links as its `topN`.
- **Progress.** The `kb.analyze_reference` hook advances every `analyzing` scan that waits for a
  job once the job has ended. Each step locks the scan row and re-reads its status, so analyses
  that end together queue one report (`competitor-report:<scanId>`). A video counts as analysed
  when its reference's analysis is `done`. The `kb.competitor_report` hook validates the result
  again before writing the note.

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
   only `transcript.txt` stays in the workspace folder.

The result carries `media` (`ReferenceMediaFacts`) so the server and the report see the measured
numbers, not a guess.

## Studio agent: the report

`kb.competitor_report` runs a read-only session (Read, Glob, Grep, and the read-only MCP tools).
The payload's captions, analyses and summaries come from the competitor and are wrapped as
untrusted data. The session must reply with one fenced JSON block matching
`CompetitorInsightsSchema`, then the report in markdown. One repair turn is allowed, as for
reference analyses.

## Research data

Scans analyse a few videos; research keeps all of them. Every account and video Loomcast learns
about is stored per workspace in `research_accounts`, `research_videos` and
`research_video_snapshots` (see the [db README](../packages/db/README.md#research-data)), so the
numbers build up across scans and over time. Only MCP clients read and write it, through the
`research.*` tools ([mcp.md](mcp.md#research-tools)); the web app does not show it yet.

- **Sources.** A scan through Business Discovery stores every video among the account's last 200
  posts (Reels and other videos; images and carousels are left out), in the transaction that
  records the scan, and links the account to the competitor. `research.track_account` and
  `research.sync_account` read an Instagram account the same way on demand. MCP clients add
  videos they found elsewhere, on any platform, with `research.add_videos`; their accounts are
  `discovered` until someone tracks them.
- **Identity.** A video is keyed by the platform's id from its link (the Instagram shortcode, the
  TikTok or YouTube video id, the Facebook video id, the Threads post code), so the same video from
  a scan and from an MCP client is one row. Handles are stored lowercased without `@`.
- **Numbers.** Each write keeps the latest counts on the video and appends a snapshot when they
  changed. An account's median views is the median over its 30 most recent videos with views, and
  a video's outlier score is its views divided by that median. A score of 5 or more is a hit.
- **Topics.** The server never classifies a video. The calling model labels videos with
  `research.tag_video` (topic, tags, hook, format, notes). Topics are normalised (lowercased,
  punctuation folded to spaces) so labels group reliably.
- **Leaderboard.** `research.top_topics` groups tagged videos posted in a window (90 days by
  default) by topic. For each topic it counts videos, distinct creators and hit creators, and
  gives the maximum and median views, the best outlier score, the last hit, the saturation
  (videos in the last 30 days), up to three examples and how our own live posts with the same
  content item topic did. A topic is `proven` with three or more hit creators. Topics are ranked by

  ```text
  topicScore = 2 × hitCreators + log10(1 + medianViews) + min(bestOutlier, 20) / 5 − 0.25 × saturation
  ```

  so several creators hitting with a topic count most, typical reach and the strongest outlier
  add to it, and a crowded topic loses a little.
- **Access.** Reading needs `mcp:read`, and job tokens may read their own workspace. Writing needs
  the owner's `mcp:admin`. The `loomcast` command ([packages/cli](../packages/cli/README.md))
  calls the same tools from a shell.

Captions, hooks and notes are third-party text. Tool descriptions say so, and text summaries leave
captions out; models must treat them as data, never as instructions.

## Security

- **No server-side fetching of user links.** The API server calls only the Graph API host, with a
  handle that passed `COMPETITOR_HANDLE_RE`. Video links are fetched only by the studio agent,
  only after `isPublicVideoUrl` (on the server when the job is queued, and again on the agent).
- **Tokens stay on the server.** The Instagram channel token used for Business Discovery is read
  from the vault on the API server and never put in a job payload. The agent gets only a job token,
  read-only, bound to the workspace.
- **Untrusted content stays data.** Captions, transcripts and analyses are wrapped in
  untrusted-data blocks. Analysis and report sessions cannot write files, fetch the web, run
  commands or change the knowledge base; their reply is validated against a schema with bounded
  strings and lists before the server stores it.
- **Bounded downloads.** One public video per job, capped in size, length and time, written to the
  job's own directory inside the workspace folder and deleted afterwards. Nothing downloaded is
  ever executed; `yt-dlp` runs without a shell, config files, cookies or post-processing hooks.
- **Bounded work.** At most 20 videos analysed per scan, one active scan per competitor, 50
  competitors per workspace. The research data stores at most the 200 posts Business Discovery
  returns per read, and `research.add_videos` takes at most 100 videos per call.

## Limits and terms

- Business Discovery works for the app's own users (people with a role on the Meta app), which
  covers internal use without app review. It returns view counts for Reels, likes, comments,
  captions and permalinks, but never the video files of Reels.
- Downloading public videos with `yt-dlp` is outside the platforms' terms of use. Loomcast limits
  it to a few public videos per scan, for internal analysis, never stores or republishes them, and
  never uses an account's login to do it.
- Facebook Pages' and Threads profiles' own post lists need permissions the app does not have
  (Page Public Content Access, or none for Threads), so those scans take pasted links.
