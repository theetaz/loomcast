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
| `src/enums.ts` | The M1 enumerations from the data model: user roles, token kinds and scopes, project status, job types and statuses, message roles, actor kinds |
| `src/common.ts` | Ids (UUID), ISO timestamps, chat text limits |
| `src/api/*` | REST DTOs for auth, projects, conversations and messages, jobs, devices and pairing, access tokens; `ApiError`; list and cursor-page shapes |
| `src/api/routes.ts` | `routes`: method, path, auth mode, and the params, query, body and response schemas of every REST route |
| `src/events.ts` | `LiveEvent`, the union of server-sent events on `/api/stream`, and `parseLiveEvent` |
| `src/bridge/*` | Bridge protocol: `PROTOCOL_VERSION`, close codes, limits and timings, the envelope, the `AgentToServer` and `ServerToAgent` unions, `encode`, `parseAgentMessage` and `parseServerMessage` |
| `src/jobs/concurrency.ts` | Concurrency classes and the credits shape |
| `src/jobs/durable-events.ts` | Durable job event kinds and the `data` schema of each |
| `src/jobs/registry.ts` | `jobRegistry`, the job allow-list, with payload and result schemas, timeouts and retry policy per type |
| `src/mcp/project-tools.ts` | `projectTools`: name, scope, description, input and output of `project.create`, `project.get` and `project.list` |
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
- `auth: "session"` routes use the cookie session; unsafe methods also pass the CSRF guard. `auth: "none"` routes are public and rate-limited.
- Error responses always have the body `ApiError`: `{error: {code, message, details?}}`.
- Small collections return `{items}`. Messages are cursor-paginated: `?cursor=&limit=` returns `{items, nextCursor}`, where `nextCursor` is `null` on the last page.

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
- `BRIDGE_TIMINGS` holds the shared intervals: server ping 20 s, job heartbeat 15 s, delta batching 100 ms, accept timeout 30 s, a 10-minute lease that doubles as the disconnect grace period, and the reconnect backoff (1 s to 60 s, reset after 60 s connected).

## Job registry

`jobRegistry` is the allow-list of job types. Every value of `JOB_TYPES` must have an entry, and the server and the studio agent both refuse anything else.

| Type | Payload | Result | Timeout | Attempts | On lease expiry | Class |
|---|---|---|---|---|---|---|
| `system.ping` | `{}` | `{agentVersion, runtime: {node, platform}, producerAvailable}` | 30 s | 3 | `requeue` | `producer` |
| `producer.chat` | `{conversationId, projectId, messageId, text, producerSessionId?}` | `{sdkSessionId, finalText, numTurns, durationMs}` | 30 min | 1 | `fail` | `producer` |

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
- Tokens: `lc_mcp_` or `lc_dev_` followed by 43 base62 characters (32 random bytes, zero-padded).

## Scripts

```bash
pnpm --filter @loomcast/contracts typecheck
pnpm --filter @loomcast/contracts test
```
