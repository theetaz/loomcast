# Production pipeline

A content item is one short video. It moves from an idea through script, storyboard, voice and
render to review, where a person approves it, asks for changes or rejects it. The studio agent
does the production work as jobs over the bridge; the server turns each job's result into a new
version of the item and decides what happens next. This guide covers the states, the actions,
autopilot, versions, reviews and how timing is fixed once the voice exists. The
[studio runtime guide](studio-runtime.md) covers rendering on the Mac.

The state machine lives in `packages/contracts/src/pipeline/transitions.ts`
(`PIPELINE_TRANSITIONS`, `allowedActions`). The API checks every state change against it, and the
web app derives its buttons from it.

## Series and formats

A **format** holds the rules every video of a series follows: tone, reading grade, hook style,
length range, the TTS provider's voice ID and speed, the visual style (`vox-explainer` by
default) and captions, a topic pool and an avoid list, the publishing cadence, the publish mode,
hashtags and a call to action. Formats are versioned: every save creates a format version, and the
editor shows the history with a JSON diff. Several series may share a format.

A **series** groups items that share a format. Create one on a workspace's **Series** page; choosing
"New format with default rules" opens the format editor next. The default rules have no voice, so
production stops before the voice step until a voice ID is set.

Every production job carries a snapshot of the format version it was queued with
(`format: {formatVersionId, rules}`), so changing a format never alters a running job. An item
without a series is produced with the default rules.

## States

| State | Meaning | Reached by |
|---|---|---|
| `idea` | A title and an optional pitch; no artifacts | Creating an item (version 1), restoring an archived one |
| `script` | The current version has a script | `write_script`, `revise`, a script edit, a request for changes |
| `storyboard` | It also has a storyboard | `storyboard`, a storyboard edit |
| `voice` | It also has a voice take | `voice`, choosing another take |
| `render` | It also has a render and a poster | `render` with autopilot stopping at `render` |
| `review` | A rendered version waits for a decision | `render` (autopilot or a single step), `submit` |
| `approved` | A person approved the current version | Approve |
| `scheduled` | Approved, with its posts queued for their slots | Approval rules, once an approved item has a post ([scheduling guide](scheduling-and-publishing.md#approval-rules)) |
| `published` | Its first post went out, live or in dry-run | The publisher ([scheduling guide](scheduling-and-publishing.md#dry-run-and-going-live)) |
| `archived` | Out of the pipeline | Archive, Reject |

A version's **stage** is the last of script, storyboard, voice and render it has without a gap
(`stageForArtifacts`): a version with a voice but no storyboard is at `script`. A new version
moves the item to its stage, except that a render goes on to review.

Allowed moves:

- **Production** (`idea` to `render`, and `review`): any actor may add a version; the item moves to
  the version's stage. A version taken out of review (for example a regenerated voice) returns the
  item to that stage until it is rendered again.
- **Review**: only a person decides, in the web app or, for the owner, with the `content.review`
  MCP tool, which records the decision as the owner's ([MCP server](mcp.md)). Tokens and devices
  never get the move themselves. Approve needs a render. Request changes moves the item to
  `script`; Reject archives it. When every planned post of an item entering review publishes in
  the `auto` mode, the system approves it instead (see
  [approval rules](scheduling-and-publishing.md#approval-rules)).
- **Approved items**: editing the script, storyboard or voice sends the item back into
  production; a caption or notes change keeps it approved.
- **Archive and restore**: any state may be archived; restoring brings the item back as an idea.

## Actions and job types

`POST /api/content/:id/actions` with `{"action": "<action>"}` starts work. What is allowed
follows `allowedActions` for the item's state and current version.

| Action | Needs | Job type | Result |
|---|---|---|---|
| `write_script` | an idea | `content.write_script` | A script (title, hook, segments, call to action, caption, hashtags, estimated length) |
| `storyboard` | a script | `content.storyboard` | Frames of the format's style: a card per segment, slot text, start and end |
| `voice` | a storyboard and a voice ID in the format | `content.voice` | A `voice` asset with its word timings |
| `render` | a voice take | `content.render` | A `render` asset (1080×1920 MP4) and a `poster` |
| `revise` | a script | `content.revise` | A revised script or storyboard, with a summary of the change |
| `produce` | an item not yet in review | the first missing step | Autopilot, below |

| Job type | Runs as | Concurrency | MCP access | Timeout | Attempts |
|---|---|---|---|---|---|
| `content.write_script` | producer session | producer | read and write | 20 min | 2, requeued on lease expiry |
| `content.storyboard` | producer session | producer | read and write | 20 min | 2, requeued |
| `content.revise` | producer session | producer | read and write | 20 min | 1, failed on lease expiry |
| `content.voice` | studio runtime and the TTS provider | render | read and write | 10 min | 3, requeued |
| `content.render` | studio runtime, HyperFrames and ffmpeg | render | read and write | 45 min | 2, requeued |
| `skills.sync` | studio agent | render | read | 5 min | 3, requeued |

Payloads name the workspace, the item, the version the job starts from and the format snapshot;
`voice` adds the voice ID and speed, `render` the voice asset, and `revise` the review comment.
Artifacts are never in the payload: the studio agent reads them through MCP with the job's own
token (`content.get`, `asset.get_url`, `format.get_rules`) and uploads media with
`content.upload_asset` and `content.finalize_asset`. The server never accepts a version written
by the agent directly; it builds versions from job results. The registry (`jobRegistry` in the
contracts) is the allow-list both sides check.

Rules that apply to every step:

- One production job per item at a time: a second action answers 409 `job_in_progress`.
- The idempotency key is `<action>:<itemId>:<versionId>`, so repeating a click while a step runs
  returns the same job. A step that already ran on the version (a failed attempt) gets a `:<n>`
  suffix and runs again.
- `voice` without a voice ID in the format answers 422 `voice_not_configured`; a missing input
  answers 422 `missing_artifact`; an item in a state that allows no production work answers 409
  `invalid_transition`.

In the web app, **Produce** on the item page and **Produce through review** in the library's
quick actions run `produce`. The voice tab's **Regenerate** runs `voice` again.

## Autopilot

`produce` drives an item to a target state, `review` by default (`{"action": "produce",
"through": "render"}` stops earlier). It records the target on the item (`autopilot_target`) and
queues the first missing step. Each successful step queues the next one; once the version has a
render, the item goes to review and autopilot turns off. The cadence scheduler's
`cadence.produce` task uses the same path ([scheduling guide](scheduling-and-publishing.md)).

Autopilot stops, and the item shows the reason as its **last error**, when:

- a job fails or is cancelled (the studio agent's error code and message);
- a result can no longer be used: the item moved on while the job ran (`stale_version`), or the
  job named assets that are not ready assets of the item (`invalid_result`);
- the next step is refused, for example `voice_not_configured`.

A single manual step turns autopilot off, so it never fights a person's work. Produce again to
continue from where the item is.

## Versions

Every item has a version from the moment it is created, and every change makes a new one: each
job result, each edit in the web app and each MCP submission. Versions are never changed or
deleted, so the timeline on the item page shows the whole history and any two scripts can be
compared word by word.

- A job result becomes a version at most once (`content_versions.job_id` is unique), so a
  completion the agent resends after a reconnect changes nothing.
- A version builds on the version its job started from. When the item has moved on since, the
  result is not used (`stale_version`); an edit from a stale page answers 409 and offers to load
  the newer version.
- Changing an artifact clears what was made from it: a new script clears the voice, render and
  poster (and the storyboard unless one is given with it); a new storyboard clears the render and
  poster; a new voice take clears the render and poster. Notes describe one version and are not
  copied forward.
- Media files are assets: content-addressed (`projects/<workspaceId>/<kind>/<sha256>.<ext>` in the
  private bucket), verified by size and SHA-256 when finalized, and kept with every version that
  used them. The voice tab lists every take of the item, and "Use this take" makes a new version
  with another one.

One pass from idea to review makes versions 2 to 5 (script, storyboard, voice, render). A
revision adds four more: the revised script, then storyboard, voice and render again.

## Reviews

Items in review are listed in their workspace's **Review** (the review queue), nearest target date
first, then the longest waiting. `j` and `k` move between them and Enter opens one; the decisions
are on the item page, in its Review panel:

- **Approve** needs a rendered current version and moves the item to `approved`.
- **Request changes** needs a comment. With **Ask the producer to revise** (on by default) the
  server queues `content.revise` with the comment as the owner's instructions and sets autopilot
  to bring the item back to review: the revised script is storyboarded, voiced and rendered
  again. Without it the item stays in `script` for manual work.
- **Reject** asks for confirmation and archives the item.

Every decision is stored with the version it was about and listed under "Earlier decisions".
There are no single-key shortcuts for decisions; ⌘Enter sends a request for changes.

## Timing after the voice

The order is fixed: the storyboard is cut before the voice exists, so its frames are timed from
the script's estimated length. When the voice step succeeds, the server:

1. matches the take's word timings to the script's words and gives each segment its spoken
   `startMs` and `endMs`;
2. re-times the storyboard to those spans: the frames of each segment are stretched or shrunk
   onto the segment's spoken time, the first frame starts at 0 and the last one ends with the
   voice, so no card runs past the take. When the frames do not follow the segments in order,
   the whole storyboard is scaled instead.

A storyboard made after the voice (a revised storyboard on the same script) is re-timed the same
way. The render then checks every frame against its card's minimum and maximum length and the
voice length; a frame stretched past its card's limit fails the render with a storyboard issue
(`frame_too_long`, `frame_too_short`, `beyond_voice`), shown as the item's last error. Revise the
storyboard or regenerate the voice and render again.

The render's measured length is compared with the format's length range with 10% tolerance. A
video outside it is not refused; the version gets a note ("The render runs 72.4 s, longer than the
format's 30–60 s allows").

## Skills

Producer steps follow skills: versioned packs of text files (`skill.json` and `SKILL.md`, plus
any templates) such as `scriptwriting`, `storyboarding`, `captions-and-pacing`, `revision` and
the `vertical-explainer` recipe in `studio/skills/`.

- **Publish** with the MCP tool `skill.publish` and an access token with `mcp:write` (job tokens
  may not publish), or seed every skill of a folder:

  ```bash
  pnpm --filter @loomcast/api run skills:seed -- ../../studio/skills
  ```

  The checksum is the SHA-256 over the sorted `path`, NUL, `content` pairs. Publishing identical
  files returns the latest version; anything else creates the next version and queues one
  `skills.sync` job.
- **Pull** with `skill.pull` (job tokens allowed): every skill at its latest version, or one
  skill at a given version. The studio agent's `skills.sync` pulls them into
  `~/Loomcast/skills/<name>/` atomically and records the versions and checksums in
  `manifest.json`. Producer steps load synced skills whose files still match, and fall back to
  the bundled `studio/skills/` otherwise.
- `GET /api/skills`, `GET /api/skills/:name` and `GET /api/skills/:name/versions` list them.

A format may name a recipe (`rules.recipe`) to guide its producer steps. The MCP tools are
documented in [mcp.md](mcp.md).

## Checking it

`pnpm test:e2e` runs this whole flow with the fake studio agent (`tests/e2e/specs/pipeline.spec.ts`):
a skill is published and synced, a series gets a new format with a voice, an idea is produced
through review, the review screen shows the script, storyboard, voice take and video, a request
for changes brings version 9 back to review, and approving it keeps all nine versions. The fake
agent answers with fixtures and uploads synthetic media, so it needs object storage but no
producer runtime, TTS provider or renderer. The real run on the Mac is the
[M3 acceptance runbook](runbooks/m3-acceptance.md).
