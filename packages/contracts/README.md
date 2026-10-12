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
| `src/util/slug.ts` | `slugify`, `SLUG_RE` and `SlugSchema` |

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
