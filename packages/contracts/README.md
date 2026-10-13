# @loomcast/contracts

Zod schemas and TypeScript types shared by the API, the web app, the studio agent, the database package and the MCP server. Everything that crosses a process boundary is defined here once.

- The only runtime dependency is `zod`.
- The package is consumed as TypeScript source (`exports: {".": "./src/index.ts"}`), so there is no build step.
- It runs in the browser and in Node. The source compiles against `lib: ["ES2023"]` with no ambient types, so it cannot use Node or DOM APIs by accident.

## Naming

Each shape has a schema with a `Schema` suffix and a type of the same base name:

```ts
import { CreateProjectSchema, type CreateProject } from "@loomcast/contracts";

const input: CreateProject = CreateProjectSchema.parse(body);
```

Enumerations are `as const` arrays (`JOB_TYPES`), a zod enum (`JobTypeSchema`) and a union type (`JobType`). `@loomcast/db` builds its pg enums from the arrays.

## Contents

| Module | Contents |
|---|---|
| `src/enums.ts` | The enumerations from the data model: user roles, token kinds and scopes, project status, job types and statuses, message roles, actor kinds, knowledge-base entry kinds and sources, reference platforms and analysis statuses, password-token purposes, pipeline states, content actions, how versions and items were created, series statuses, publish modes, asset kinds and statuses, review decisions, skill kinds |
| `src/common.ts` | Ids (UUID), ISO timestamps, chat text limits |
| `src/api/*` | REST DTOs for auth, projects, conversations and messages, jobs, devices and pairing, access tokens, the knowledge base (`kb.ts`), users and set-password links (`users.ts`), formats, series, content items and versions (`content.ts`), reviews, assets and skills; `ApiError`; list and cursor-page shapes |
| `src/api/routes.ts` | `routes`: method, path, auth mode, and the params, query, body and response schemas of every REST route |
| `src/events.ts` | `LiveEvent`, the union of server-sent events on `/api/stream`, and `parseLiveEvent` |
| `src/bridge/*` | Bridge protocol: `PROTOCOL_VERSION`, close codes, limits and timings, the envelope, the `AgentToServer` and `ServerToAgent` unions, `encode`, `parseAgentMessage` and `parseServerMessage` |
| `src/jobs/concurrency.ts` | Concurrency classes and the credits shape |
| `src/jobs/durable-events.ts` | Durable job event kinds and the `data` schema of each |
| `src/jobs/registry.ts` | `jobRegistry`, the job allow-list, with payload and result schemas, timeouts and retry policy per type, and `FormatSnapshotSchema` |
| `src/mcp/contract.ts` | `McpToolContract`, `MCP_PATH`, the job-token policies and project bindings |
| `src/mcp/project-tools.ts` | `projectTools`: `project.create`, `project.get` and `project.list` |
| `src/mcp/kb-tools.ts` | `kbTools`: the `kb.*` tools |
| `src/mcp/admin-tools.ts` | `adminTools`: `admin.create_user` |
| `src/mcp/pipeline-tools.ts` | `pipelineTools`: format, content, asset and skill tools |
| `src/mcp/tools.ts` | `mcpTools`, every tool by name |
| `src/pipeline/transitions.ts` | `PIPELINE_TRANSITIONS`, the pipeline state machine, with `canTransition`, `findTransition`, `allowedActions`, `stageForArtifacts` and `nextProductionStep` |
| `src/pipeline/format-rules.ts` | `FormatRulesSchema`, the rules of a format version, and `DEFAULT_FORMAT_RULES` |
| `src/pipeline/artifacts.ts` | `ScriptSchema`, `StoryboardSchema` and `VoiceAlignmentSchema`, the artifacts of a content version |
| `src/pipeline/style.ts` | Style, card and slot id shapes from the studio's style library |
| `src/pipeline/skills.ts` | Skill names, versions, file paths and limits, `skill.json`, and `skillChecksumInput` |
| `src/kb/analysis.ts` | `ReferenceAnalysisSchema`, the structured analysis of a reference video, and its caps |
| `src/util/reference-url.ts` | `normalizeReferenceUrl` and `detectReferencePlatform`: pure link cleaning and platform detection |
| `src/util/slug.ts` | `slugify`, `SLUG_RE` and `SlugSchema` |
| `src/util/ulid.ts`, `src/util/utf8.ts` | ULID message ids and UTF-8 byte length, without platform APIs beyond Web Crypto |

## REST routes

`routes` maps a route name to its definition:

```ts
import { buildPath, routes, type RouteResponse } from "@loomcast/contracts";

const route = routes["messages.post"];
const url = buildPath(route.path, { id: conversationId }); // "/api/conversations/<id>/messages"
const body = route.body.parse({ text, clientMessageId });
type Reply = RouteResponse<"messages.post">; // { message, job }
```

- `response: null` means the route answers `204 No Content`.
- `auth: "session"` routes use the cookie session; unsafe methods also pass the CSRF guard. `auth: "none"` routes are public and rate-limited: login, the two set-password routes and device pairing.
- The `users.*` routes are owner-only.
- Register `kb.search` (`GET /api/kb/search`) before the `/api/kb/:id` routes.
- Error responses always have the body `ApiError`: `{error: {code, message, details?}}`.
- Small collections return `{items}`. Messages, knowledge-base entries, content items and the review queue are cursor-paginated: `?cursor=&limit=` returns `{items, nextCursor}`, where `nextCursor` is `null` on the last page.

## Knowledge base

Entries belong to a project and have a `kind`: `brainstorm`, `reference`, `decision`, `note` or `session_summary`.

| Route | Request | Response |
|---|---|---|
| `kb.list` `GET /api/projects/:projectId/kb` | `?kinds=a,b&tag=&cursor=&limit=` | `{items: KbEntry[], nextCursor}` |
| `kb.create` `POST /api/projects/:projectId/kb` | `CreateKbEntry` (by `kind`) | `KbEntryDetail` |
| `kb.capture` `POST /api/projects/:projectId/kb/capture` | `{conversationId, messageIds[1..200], title, kind: brainstorm\|note, tags?}` | `KbEntryDetail` |
| `kb.tags` `GET /api/projects/:projectId/kb/tags` | | `{items: [{tag, count}]}` |
| `kb.search` `GET /api/kb/search` | `?q=&projectId=&kinds=&limit=` (`q` 1 to 200 characters, `limit` at most 50) | `{items: KbSearchHit[]}` |
| `kb.get` `GET /api/kb/:id` | | `KbEntryDetail` |
| `kb.update` `PATCH /api/kb/:id` | `UpdateKbEntry`, with `expectedUpdatedAt` | `KbEntryDetail`, or `409 conflict` |
| `kb.delete` `DELETE /api/kb/:id` | | `204` |
| `kb.analyze` `POST /api/kb/:id/analyze` | | `JobSummary` of a `kb.analyze_reference` job |

- `CreateKbEntry` is discriminated on `kind`. Brainstorms and notes take `{title, bodyMd, tags?}`; decisions `{title, decision, rationale?, supersedes?, tags?}`; references `{url, title?, likedReason?, author?, transcript?, tags?}`. Session summaries are written only through MCP.
- `KbEntry` is what lists and live events carry. `KbEntryDetail` adds `reference`, the `KbReferenceDetail` of a reference entry (URL, platform, author, liked reason, transcript, analysis and its status), and is `null` for other kinds.
- `data` holds the kind-specific fields: `DecisionData` `{decision, rationale?, status: active|superseded, supersededBy?}` for decisions, `{sessionId, cwd?}` for session summaries, and the capture origin for brainstorms and notes. Check it with `parseKbEntryData(kind, data)`.
- `UpdateKbEntry` requires `expectedUpdatedAt`, the `updatedAt` the client last saw. A stale value gets `409 conflict` and changes nothing.
- Search snippets mark matches with `\u0002` before and `\u0003` after (`KB_SNIPPET_MATCH_START`, `KB_SNIPPET_MATCH_END`), never with HTML. `splitKbSnippet` turns a snippet into `{text, match}` parts for rendering.
- Reference links go through `normalizeReferenceUrl(input)`, which returns `{url, platform}`. It lowercases the host, drops a leading `www.` or `m.`, removes `utm_*`, `igsh`, `igshid`, `si`, `fbclid`, `feature` and `ref`, and detects the platform from the host. It never fetches the link, and it throws `ReferenceUrlError` for anything that is not an http(s) URL.

## Users and set-password links

There is no sign-up. The owner invites a user (`users.invite`, or `admin.create_user` over MCP) and hands over the one-time `setPasswordUrl`; `users.resetLink` issues a new one. Invitation links last 7 days and reset links 24 hours (`PASSWORD_TOKEN_TTL_MS`). The set-password page calls `auth.inspectPasswordToken` to show the email, then `auth.setPassword` with `{token, newPassword}`. A password is never returned.

## Production pipeline

A content item moves through `PIPELINE_STATES`:

| State | Meaning |
|---|---|
| `idea` | A title and pitch, no artifacts yet |
| `script`, `storyboard`, `voice`, `render` | The production stage the current version has reached |
| `review` | A rendered version waits for a user's decision |
| `approved` | Ready to schedule |
| `scheduled`, `published` | On the calendar, then live (M4) |
| `archived` | Out of the pipeline; restoring makes it an `idea` again |

`PIPELINE_TRANSITIONS` is the single source of truth for state changes. Each row is `{from, to, via, actors, requiresRender}`; anything not listed is refused. The API checks every change with `canTransition(from, to, actor, version)` (or `findTransition` to get the row), and the web app offers only what `allowedActions(state, actor, role, version)` returns.

| `via` | Moves | Actors |
|---|---|---|
| `version` | from `idea`, a production stage or `review` to the new version's stage (`script` to `render`) | user, device, token, system |
| `version` | `review` to `review` (only the caption or notes changed; needs a render) | user |
| `submit` | a production stage to `review` (needs a render) | user, device, token, system |
| `approve` | `review` to `approved` (needs a render) | user |
| `request_changes` | `review` to `script` | user |
| `reject` | `review` to `archived` | user |
| `edit` | `approved` to `script`, `storyboard` or `voice`; `approved` to `approved` when only the caption or notes changed | user |
| `schedule`, `unschedule` | `approved` to `scheduled` and back (needs a render) | user, system |
| `publish` | `scheduled` to `published` (needs a render) | system |
| `archive` | any state except `archived` to `archived` | user |
| `restore` | `archived` to `idea` | user |

- `from === to` rows allow a new version that leaves the state unchanged.
- Devices and tokens only ever add versions and submit to review. Approving, rejecting, archiving and restoring are for users; from M4, approval may also come from `system` under a series' `auto` publish mode.
- `version` is the version the item ends up on. Rows with `requiresRender` are refused when it is missing or has no `renderAssetId`.
- `stageForArtifacts(version)` is the last of script, storyboard, voice and render present without a gap; a version with nothing is at `idea`. `nextProductionStep(version)` is the action that adds the next artifact, or `null` once there is a render.
- `allowedActions` returns `ITEM_ACTIONS`: the `CONTENT_ACTIONS` (`write_script`, `storyboard`, `voice`, `render`, `revise`, `produce`), `submit`, the review decisions, `edit`, `archive` and `restore`. Users and autopilot (`system`) may start production work in a production stage or in `review` once the previous artifact exists (`storyboard` needs a script, `voice` a storyboard, `render` a voice, `revise` a script); `produce` does not start from `review`. A user without a role gets nothing; both roles have the same pipeline rights.
- `REVIEW_DECISION_STATES` maps each decision to its target state. `produce` runs the missing steps up to a `ProduceTarget` (`DEFAULT_PRODUCE_TARGET` is `review`).

### Pipeline REST routes

All of them use the cookie session. Lists of formats, series, versions, reviews, assets and skills return `{items}`; content and the review queue are cursor-paginated.

| Route | Request | Response |
|---|---|---|
| `formats.list` `GET /api/projects/:projectId/formats` | | `{items: Format[]}` |
| `formats.create` `POST /api/projects/:projectId/formats` | `{name, slug?, rules?}` (rules default to `DEFAULT_FORMAT_RULES`) | `Format` (201) |
| `formats.get` `GET /api/formats/:id` | | `Format`, with `currentVersion` |
| `formats.update` `PATCH /api/formats/:id` | `{baseVersionId, name?, rules?}` | `Format`; every update stores a new version; `409 conflict` when `baseVersionId` is stale |
| `formats.versions` `GET /api/formats/:id/versions` | | `{items: FormatVersion[]}`, newest first |
| `series.list`, `series.create` `/api/projects/:projectId/series` | `?status=`; `{name, slug?, formatId}` | `{items: Series[]}`; `Series` (201) |
| `series.get`, `series.update` `/api/series/:id` | `{name?, formatId?}` | `Series` |
| `series.pause`, `series.resume`, `series.archive` `POST /api/series/:id/<action>` | | `Series` |
| `content.list` `GET /api/content` | `?projectId=&states=a,b&seriesId=&q=&targetFrom=&targetTo=&cursor=&limit=` | `{items: ContentItem[], nextCursor}`; archived items only when `states` asks for them |
| `content.create` `POST /api/projects/:projectId/content` | `{title, pitch?, topic?, seriesId?, targetAt?}` | `ContentItemDetail` (201) |
| `content.get` `GET /api/content/:id` | | `ContentItemDetail`: `{item, currentVersion, versions, activeJob}` |
| `content.update` `PATCH /api/content/:id` | `{title?, pitch?}` | `ContentItem` (no new version) |
| `content.versions.list` `GET /api/content/:id/versions` | | `{items: ContentVersionSummary[]}` |
| `content.versions.get` `GET /api/content/:id/versions/:versionId` | | `ContentVersion` |
| `content.versions.edit` `POST /api/content/:id/versions` | `{baseVersionId, script?, storyboard?, caption?, voiceAssetId?, notes?}` | `{item, version}` (201); `409 conflict` when the base is stale |
| `content.actions` `POST /api/content/:id/actions` | `{action, through?}` (`through` for `produce` only) | `JobSummary` (201) |
| `content.archive`, `content.restore` `POST /api/content/:id/<action>` | | `ContentItem` |
| `content.conversation` `POST /api/content/:id/conversation` | | `Conversation`, created on first use |
| `content.assets` `GET /api/content/:id/assets` | `?kind=` | `{items: Asset[]}`, such as every voice take |
| `reviews.create` `POST /api/content/:id/reviews` | `{versionId, decision, comment?, enqueueRevision?}` | `{review, item}` (201) |
| `reviews.list` `GET /api/content/:id/reviews` | | `{items: Review[]}` |
| `reviews.queue` `GET /api/reviews/queue` | `?projectId=&cursor=&limit=` | `{items: ContentItem[], nextCursor}`: items in `review` by `targetAt` (nulls last), then `updatedAt` |
| `assets.createUpload` `POST /api/assets/uploads` | `{projectId, itemId?, kind, filename, mime, bytes, sha256}` | `{asset, upload: {url, method: "PUT", headers, expiresAt} \| null}` (201) |
| `assets.finalize` `POST /api/assets/:id/finalize` | `{probe?, alignment?}` | `Asset` |
| `assets.get` `GET /api/assets/:id` | | `AssetDetail` (adds a voice take's `alignment`) |
| `assets.url` `GET /api/assets/:id/url` | `?disposition=inline\|attachment` | `{url, expiresAt}` |
| `skills.list` `GET /api/skills` | | `{items: SkillSummary[]}` |
| `skills.get` `GET /api/skills/:name` | `?version=` (latest by default) | `SkillVersionDetail`, with files |
| `skills.versions` `GET /api/skills/:name/versions` | | `{items: SkillVersionSummary[]}` |

- Every item has a current version from the start: version 1 is the bare idea, created together with the item.
- Versions never change. `content.versions.edit` copies the base forward with the changes: a new script clears the voice, render and poster; a new storyboard clears the render and poster; a new `voiceAssetId` (a ready voice take of the same item) clears the render. The new state follows from `PIPELINE_TRANSITIONS`.
- `content.actions` answers `409 job_in_progress` while the item has an active production job, `422 missing_artifact` when the step's input is missing, and `422 voice_not_configured` for a voice without a format voice. A refused state change is `409 invalid_transition`.
- `reviews.create` decides the current version of an item in `review`. Requesting changes needs a comment and queues a `content.revise` job unless `enqueueRevision` is `false`; `enqueueRevision` is refused for other decisions.
- Uploads never pass through the API. `assets.createUpload` checks the MIME type against the kind (`ASSET_KIND_MIME_TYPES`) and the size against its cap (`ASSET_KIND_MAX_BYTES`: renders and reference media 1 GiB, voice 100 MiB, images and other files 20 MiB). The client PUTs the bytes with exactly the returned `headers`, then finalizes; the server checks the size and SHA-256 and marks the asset `ready`, or `failed` and deletes the object. A ready asset with the same project, kind and SHA-256 comes back with `upload: null`. `alignment` is accepted for voice takes only.
- `ConversationSchema.contentItemId` and the reference's `mediaAssetId` (`KbReferenceDetail`, `CreateKbEntry`, `UpdateKbEntry`) link conversations and references to the pipeline; they are optional until every server sends them.

### Skill files

A skill is a directory of text files with a `skill.json` (`SkillManifestSchema`: `{name, kind: skill|recipe, description}`). Names match `^[a-z0-9][a-z0-9-]{0,63}$`.

- At most 200 files and 1 MiB of UTF-8 content in total (`SKILL_MAX_FILES`, `SKILL_MAX_BYTES`). Contents are plain text without control characters other than tab and line breaks.
- Paths match `^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$` and are relative: no leading or trailing `/`, no empty or `.` segments (`isSkillPath`). Two paths that differ only in case are refused, since they would collide on a case-insensitive disk.
- The checksum is the SHA-256 of the UTF-8 bytes of `skillChecksumInput(files)`: `path`, NUL, `content` for every file sorted by path, joined with NUL.

### Format rules

A format is versioned; every update stores a new `FormatRules` version. Production jobs carry a snapshot of the rules they run with.

| Field | Rule |
|---|---|
| `tone` | at most 200 characters |
| `readingLevel.grade` | integer 3 to 16 |
| `hookStyle`, `hookNotes?` | `question`, `bold_claim`, `statistic`, `story`, `contrarian` or `demo`; notes at most 1,000 characters |
| `lengthSec` | `{min, max}`, integers 5 to 180, `min <= max` |
| `voiceId?`, `voiceSpeed?` | the TTS provider's voice id; speed 0.7 to 1.3. Without a voice the `voice` step answers `voice_not_configured` |
| `visualTemplate` | `{styleId, templateId?, captions: {enabled, style: word\|line}}` |
| `topicPool`, `avoid` | at most 500 and 200 entries of 1 to 200 characters |
| `cadence` | `{days, slots, tz, leadTimeHours}`: distinct `mon` to `sun`; at most 12 distinct `HH:mm` slots; an IANA time zone this runtime knows (`isTimeZone`, offsets refused); lead time 1 to 336 hours |
| `publishMode` | `auto` or `approval` |
| `caption` | `{hashtags, cta?}`: at most 30 hashtags without repeats (case ignored), stored without `#`; CTA at most 300 characters |
| `recipe?` | `{name, version?}` of a recipe skill |

`DEFAULT_FORMAT_RULES` is frozen; copy it before changing it. Style ids such as `vox-explainer` and card ids such as `vox-explainer.t1.section.circle` are checked for shape only (`StyleIdSchema`, `CardIdSchema`, `SlotNameSchema`); the studio runtime checks them against its registry.

### Artifacts

A content version holds a script, a storyboard, a voice take and a render. Producer sessions write the script and storyboard as JSON; the voice step reports word timings. Every artifact fits in one bridge frame.

| Schema | Shape | Rules |
|---|---|---|
| `ScriptSchema` | `{title, hook, segments: [{id, text, startMs?, endMs?, onScreenText?}], cta, caption, hashtags, estimatedDurationMs}` | 1 to 60 segments with distinct ids (`ARTIFACT_ID_RE`); segment text 1 to 1,000 characters, on-screen text at most 280; timed segments end after they start and run in order without overlaps; caption at most 2,200 characters; hashtags as in format rules |
| `StoryboardSchema` | `{styleId, fps: 30, aspect: "9:16", frames: [{id, segmentId, startMs, endMs, cardId, slots, notes?}]}` | 1 to 80 frames with distinct ids, each ending after it starts, in time order without overlaps (gaps allowed); at most 32 slots per frame, each at most 280 characters, and at most 100,000 characters of slot text in total |
| `VoiceAlignmentSchema` | `{words: [{text, startMs, endMs}]}` | at most 5,000 words in spoken order (`startMs` never decreases), none ending before it starts |

Times are whole milliseconds from 0 to 10 minutes (`MAX_TIMELINE_MS`). Text fields refuse control characters other than tab and line breaks. Slot text is plain text: the studio runtime escapes it before it reaches a card.

## Live events

`GET /api/stream` sends one `LiveEvent` per server-sent event, as JSON in `data`. Every event is `{type, payload}`:

| `type` | `payload` |
|---|---|
| `conversation.message.created` | `{message}` |
| `conversation.message.delta` | `{conversationId, jobId, text}` (ephemeral streaming text) |
| `job.updated` | `{job}` (a `JobSummary`) |
| `job.activity` | `{jobId, kind, summary, progress?}` (`progress` from 0 to 1) |
| `device.status` | `{deviceId, online, lastSeenAt}` |
| `project.created`, `project.updated` | `{project}` |
| `kb.entry.created`, `kb.entry.updated` | `{entry}` (a `KbEntry`, without transcript or analysis) |
| `kb.entry.deleted` | `{entryId, projectId}` |
| `content.item.created`, `content.item.updated` | `{item}` (a `ContentItem`; updates cover state, title, target, autopilot and `lastError`) |
| `content.version.created` | `{projectId, version}` (a `ContentVersionSummary`) |
| `asset.updated` | `{asset}` (created, finalized or failed) |
| `review.created` | `{projectId, review}` |
| `skill.published` | `{skill}` (a `SkillVersionSummary`; skills are global) |
| `resync` | `{}`: the client missed events and should refetch |

`parseLiveEvent(data)` returns `null` for unknown types, so an older web build ignores newer events.

## Bridge protocol

The studio agent connects to `/bridge/v1` over WebSocket. Every frame is a JSON envelope `{v: 1, id, type, ts, ref?, payload}`, where `id` is a ULID.

```ts
import { encode, parseServerMessage } from "@loomcast/contracts";

socket.send(encode({ type: "job.accept", payload: { jobId } }));

const parsed = parseServerMessage(frame);
if (!parsed.ok) socket.close(parsed.closeCode, parsed.reason);
else if (parsed.message.type === "job.assign") run(parsed.message.payload.job);
```

- `encode` adds `v`, `id` and `ts`, validates the message and throws `BridgeEncodeError` if it is invalid or over 1 MiB, so a sender never triggers a close on the other side.
- The parse helpers never throw. A failure carries a `reason` (`too_large`, `invalid_json`, `unsupported_version` or `invalid_message`) and the matching close code: 4426 for an unsupported version, 4400 otherwise.
- `job.assign` carries the payload as a plain object, and `job.complete` the result. Each side validates them against the job registry, so a bad payload is answered with `job.reject` or a failed job rather than a closed socket.
- `job.assign` may carry `credentials: {mcp: {endpoint, token, expiresAt}}` for a job whose type has MCP access. `endpoint` is a server path such as `/mcp`, which the agent resolves against its own `serverUrl`; `token` is a job token (`lc_job_…`) that expires at `expiresAt` or when the job ends. The producer session uses it instead of the device token, which it never sees. Credentials are never persisted: the agent keeps them in memory for the running job and never writes them to its config, outbox, journal or logs. Frames without `credentials` still parse.
- `BRIDGE_TIMINGS` holds the shared intervals: server ping 20 s, job heartbeat 15 s, delta batching 100 ms, accept timeout 30 s, a 10-minute lease that doubles as the disconnect grace period, and the reconnect backoff (1 s to 60 s, reset after 60 s connected).

## Job registry

`jobRegistry` is the allow-list of job types. Every value of `JOB_TYPES` must have an entry, and the server and the studio agent both refuse anything else.

| Type | Payload | Result | Timeout | Attempts | On lease expiry | Class | MCP access |
|---|---|---|---|---|---|---|---|
| `system.ping` | `{}` | `{agentVersion, runtime: {node, platform}, producerAvailable}` | 30 s | 3 | `requeue` | `producer` | `none` |
| `producer.chat` | `{conversationId, projectId, messageId, text, producerSessionId?, contentItemId?}` | `{sdkSessionId, finalText, numTurns, durationMs}` | 30 min | 1 | `fail` | `producer` | `read_write` |
| `kb.analyze_reference` | `{projectId, entryId, url, platform, transcript?, mediaAssetId?, likedReason?}` (a transcript or media) | `{analysis: ReferenceAnalysis, summaryMd, transcript?}` (summary at most 4,000 characters) | 15 min | 2 | `requeue` | `producer` | `read` |
| `content.write_script` | content fields | `{script, notes?}` | 20 min | 2 | `requeue` | `producer` | `read_write` |
| `content.storyboard` | content fields | `{storyboard}` | 20 min | 2 | `requeue` | `producer` | `read_write` |
| `content.revise` | content fields, `reviewId?`, `instructions?` | `{script?, storyboard?, summary}` (at least one artifact) | 20 min | 1 | `fail` | `producer` | `read_write` |
| `content.voice` | content fields, `voice: {voiceId, speed?}` | `{voiceAssetId, durationMs, alignment}` | 10 min | 3 | `requeue` | `render` | `read_write` |
| `content.render` | content fields, `voiceAssetId` | `{renderAssetId, posterAssetId, durationMs, width, height}` | 45 min | 2 | `requeue` | `render` | `read_write` |
| `skills.sync` | `{names?}` (all skills when left out) | `{synced: [{name, version}]}` | 5 min | 3 | `requeue` | `render` | `read` |

`mcpAccess` says whether a job's producer session may call the MCP server. For `read` and `read_write` the server mints a job token with the scopes in `MCP_ACCESS_SCOPES` (`mcp:read`, plus `mcp:write` for `read_write`), bound to the job's project, and sends it in `job.assign`. For `none` it sends no credentials.

`kb.analyze_reference` works from the transcript the user supplied, or from media the user uploaded (`mediaAssetId`, a `reference_media` asset), which the agent fetches through `asset.get_url`, transcribes and returns as `transcript`. The reference URL is never fetched, and transcripts are untrusted text.

The content fields of every production job are `{projectId, itemId, versionId, format: {formatVersionId, rules}}`: the item, the version the job starts from, and a snapshot of the format rules (`FormatSnapshotSchema`; `formatVersionId` is null for an item without a series). Artifacts are never in the payload; the job reads them with `content.get` and uploads media with `content.upload_asset`. `content.revise` carries the owner's request as `instructions` (a review comment, with `reviewId`), which the producer may treat as trusted. Producer steps may emit `status`, `session`, `tool.activity`, `usage` and `log` events; voice, render and sync emit `status` and `log`. A `status` event may carry `progress` from 0 to 1 (renders report every 10%), which the server forwards as `job.activity.progress`.

Use `isJobType`, `parseJobPayload(type, payload)`, `parseJobResult(type, result)` and `allowsEventKind(type, kind)` rather than reading schemas by hand; they keep the payload and result types tied to the job type.

Adding a job type takes a migration for the pg enum, a value in `JOB_TYPES` and an entry here. The registry is typed against `JOB_TYPES`, so a missing entry does not compile.

## MCP tools

`mcpTools` (the union of `projectTools`, `kbTools`, `adminTools` and `pipelineTools`) describes each tool's name, required token scope, job-token policy, project binding, description and zod input and output. The MCP server on `/mcp` (`MCP_PATH`) registers handlers against these contracts and returns each output as `structuredContent`.

- `jobTokens`: whether a job token (`lc_job_…`, handed to a producer session for one job) may call the tool. User MCP tokens are governed by `scope` alone.
- `projectBinding: "input"`: the input names one project, directly or through a record that belongs to one (an entry, series, item or asset). The server refuses a job token for any project other than its job's, and binds an omitted optional `projectId` to the job's project.
- `projectBinding: "none"`: the input names no project. With a job token, results cover only the job's project.

| Tool | Scope | Job tokens | Project | Input | Output |
|---|---|---|---|---|---|
| `project.create` | `mcp:write` | deny | none | `{name, slug?, description?}` | `{project: {id, slug, name, description, url}}` |
| `project.get` | `mcp:read` | allow | input | `{idOrSlug}` | `{project, stats: {conversations, kbEntries, items}}` |
| `project.list` | `mcp:read` | allow | none | `{status?}` | `{projects}` |
| `kb.save_brainstorm` | `mcp:write` | allow | input | `{projectId, title, bodyMd, tags?, sessionRef?}` | `{entryId, url}` |
| `kb.add_reference` | `mcp:write` | allow | input | `{projectId, url, platform?, title?, author?, likedReason?, transcript?, analysis?, tags?}` | `{entryId}` |
| `kb.add_decision` | `mcp:write` | allow | input | `{projectId, title, decision, rationale?, supersedes?, tags?}` | `{entryId}` |
| `kb.search` | `mcp:read` | allow | input | `{query, projectId?, kinds?, limit?}` (`limit` at most 50) | `{hits: KbSearchHit[]}` |
| `kb.get` | `mcp:read` | allow | input | `{entryId}` | `{entry: KbEntryDetail}` |
| `kb.save_session_summary` | `mcp:write` | deny | input | `{projectId?, sessionId, summaryMd, cwd?}` | `{entryId}` |
| `admin.create_user` | `mcp:admin` | deny | none | `{email, name, role}` | `{userId, setPasswordUrl, expiresAt}` (never a password) |
| `format.get_rules` | `mcp:read` | allow | input | `{seriesId}` | `{formatId, name, formatVersionId, version, rules}` |
| `content.create_idea` | `mcp:write` | allow | input | `{projectId, seriesId?, title, pitch, topic?}` | `{itemId}` |
| `content.get` | `mcp:read` | allow | input | `{itemId, versionId?}` | `{item, version, format: {formatVersionId, rules} \| null}` |
| `content.submit_for_review` | `mcp:write` | allow | input | `{itemId, baseVersionId?, script?, storyboard?, caption?, notes?}` (a script or storyboard) | `{versionId, versionNo, state}` |
| `content.upload_asset` | `mcp:write` | allow | input | `{itemId, kind, filename, mime, bytes, sha256}` | `{asset, upload: {url, method, headers, expiresAt} \| null}` |
| `content.finalize_asset` | `mcp:write` | allow | input | `{assetId, probe?, alignment?}` | `{asset}` |
| `asset.get_url` | `mcp:read` | allow | input | `{assetId, disposition?}` | `{url, expiresAt, asset: AssetDetail}` |
| `skill.pull` | `mcp:read` | allow | none | `{name?, version?}` | `{skills: [{name, kind, version, checksum, files}]}` |
| `skill.publish` | `mcp:write` | deny | none | `{name, kind, files, changelog?}` | `{name, version, checksum, created}` |

- `content.submit_for_review` moves the item to the stage its artifacts reach (`stageForArtifacts`); a token never approves. With `baseVersionId`, a stale base is refused instead of overwritten.
- `content.upload_asset` follows the rules of `assets.createUpload`; `upload` is null when an identical ready asset exists, and then no finalize is needed.
- `skill.publish` with unchanged files returns the latest version with `created: false`. Job tokens cannot publish skills.

## Limits and formats

- Chat messages: at most 20,000 characters, not only whitespace (`MessageTextSchema`).
- Emails are trimmed and lowercased by `EmailSchema`. New passwords are 12 to 256 characters.
- Slugs: lowercase ASCII letters and digits joined by single hyphens, at most 64 characters, and never shaped like a UUID. `slugify` returns an empty string when the input has nothing usable, so the caller picks a fallback.
- Pairing codes: `XXXX-XXXX` over an alphabet without 0, 1, I and O. Input is trimmed and uppercased.
- Tokens: `lc_mcp_` (MCP), `lc_dev_` (device) or `lc_job_` (job-scoped MCP) followed by 43 base62 characters (32 random bytes, zero-padded).
- Knowledge base: titles at most 200 characters; bodies and transcripts at most 200,000 (`MAX_KB_BODY_LENGTH`, `MAX_TRANSCRIPT_LENGTH`). Transcripts must not contain control characters other than tab and line breaks, or lone surrogates, so the largest one still fits in a bridge frame.
- Tags: at most 20 per entry, without repeats, each matching `^[a-z0-9][a-z0-9-]{0,39}$` after trimming and lowercasing.
- Set-password tokens: 32 to 128 URL-safe characters (`PASSWORD_TOKEN_RE`).

## Scripts

```bash
pnpm --filter @loomcast/contracts typecheck
pnpm --filter @loomcast/contracts test
```
