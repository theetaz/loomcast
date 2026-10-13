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
| `src/enums.ts` | The enumerations from the data model: user roles, token kinds and scopes, project status, job types and statuses, message roles, actor kinds, knowledge-base entry kinds and sources, reference platforms and analysis statuses, password-token purposes |
| `src/common.ts` | Ids (UUID), ISO timestamps, chat text limits |
| `src/api/*` | REST DTOs for auth, projects, conversations and messages, jobs, devices and pairing, access tokens, the knowledge base (`kb.ts`), users and set-password links (`users.ts`); `ApiError`; list and cursor-page shapes |
| `src/api/routes.ts` | `routes`: method, path, auth mode, and the params, query, body and response schemas of every REST route |
| `src/events.ts` | `LiveEvent`, the union of server-sent events on `/api/stream`, and `parseLiveEvent` |
| `src/bridge/*` | Bridge protocol: `PROTOCOL_VERSION`, close codes, limits and timings, the envelope, the `AgentToServer` and `ServerToAgent` unions, `encode`, `parseAgentMessage` and `parseServerMessage` |
| `src/jobs/concurrency.ts` | Concurrency classes and the credits shape |
| `src/jobs/durable-events.ts` | Durable job event kinds and the `data` schema of each |
| `src/jobs/registry.ts` | `jobRegistry`, the job allow-list, with payload and result schemas, timeouts and retry policy per type |
| `src/mcp/project-tools.ts` | `projectTools`: name, scope, description, input and output of `project.create`, `project.get` and `project.list` |
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
- Small collections return `{items}`. Messages and knowledge-base entries are cursor-paginated: `?cursor=&limit=` returns `{items, nextCursor}`, where `nextCursor` is `null` on the last page.

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

## Live events

`GET /api/stream` sends one `LiveEvent` per server-sent event, as JSON in `data`. Every event is `{type, payload}`:

| `type` | `payload` |
|---|---|
| `conversation.message.created` | `{message}` |
| `conversation.message.delta` | `{conversationId, jobId, text}` (ephemeral streaming text) |
| `job.updated` | `{job}` (a `JobSummary`) |
| `job.activity` | `{jobId, kind, summary}` |
| `device.status` | `{deviceId, online, lastSeenAt}` |
| `project.created`, `project.updated` | `{project}` |
| `kb.entry.created`, `kb.entry.updated` | `{entry}` (a `KbEntry`, without transcript or analysis) |
| `kb.entry.deleted` | `{entryId, projectId}` |
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
| `producer.chat` | `{conversationId, projectId, messageId, text, producerSessionId?}` | `{sdkSessionId, finalText, numTurns, durationMs}` | 30 min | 1 | `fail` | `producer` | `read_write` |
| `kb.analyze_reference` | `{projectId, entryId, url, platform, transcript, likedReason?}` | `{analysis: ReferenceAnalysis, summaryMd}` (summary at most 4,000 characters) | 15 min | 2 | `requeue` | `producer` | `read` |

`mcpAccess` says whether a job's producer session may call the MCP server. For `read` and `read_write` the server mints a job token with the scopes in `MCP_ACCESS_SCOPES` (`mcp:read`, plus `mcp:write` for `read_write`), bound to the job's project, and sends it in `job.assign`. For `none` it sends no credentials.

`kb.analyze_reference` works only from the transcript the user supplied. Nothing is downloaded, and the transcript is untrusted text.

Use `isJobType`, `parseJobPayload(type, payload)`, `parseJobResult(type, result)` and `allowsEventKind(type, kind)` rather than reading schemas by hand; they keep the payload and result types tied to the job type.

Adding a job type takes a migration for the pg enum, a value in `JOB_TYPES` and an entry here. The registry is typed against `JOB_TYPES`, so a missing entry does not compile.

## MCP tools

`projectTools` describes each tool's name, required token scope, description and zod input and output. The MCP server registers handlers against these contracts and returns each output as `structuredContent`.

| Tool | Scope | Input | Output |
|---|---|---|---|
| `project.create` | `mcp:write` | `{name, slug?, description?}` | `{project: {id, slug, name, description, url}}` |
| `project.get` | `mcp:read` | `{idOrSlug}` | `{project, stats: {conversations, kbEntries, items}}` |
| `project.list` | `mcp:read` | `{status?}` | `{projects}` |

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
