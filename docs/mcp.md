# MCP server

Loomcast serves its tools over the [Model Context Protocol](https://modelcontextprotocol.io) at
`/mcp`, so any MCP client can list, read and create projects with an access token. The same
endpoint serves producer sessions started by the studio agent.

## Endpoint

| | |
|---|---|
| URL | `<server>/mcp`, for example `https://loomcast.prabhavalabs.com/mcp`, or `http://localhost:8790/mcp` in development |
| Transport | Streamable HTTP, stateless |
| Methods | `POST` only. `GET` and `DELETE` answer `405`: there are no sessions and no server-to-client stream |
| Responses | `application/json` (one JSON-RPC response per request) |
| Request body | At most 1 MiB |
| Rate limit | 120 requests a minute per token, then `429` with `Retry-After` |

The server never issues an `Mcp-Session-Id`. Each request stands alone, so a client may call
`tools/list` or `tools/call` without initializing first; MCP clients still initialize as usual.
Requests must send `Content-Type: application/json` and
`Accept: application/json, text/event-stream`, as the streamable HTTP transport requires.

A request that carries an `Origin` header is refused (`403`) unless the origin is the web app's
own, which protects the endpoint from DNS rebinding. MCP clients that are not browsers send no
`Origin`.

## Authentication

Every request needs an access token in the `Authorization` header:

```http
Authorization: Bearer <access token>
```

- **Creating a token.** In the web app, open **Settings → Access tokens** and create a token with
  the scopes the client needs. The secret starts with `lc_mcp_` and is shown once. An
  administrator can also issue one from the command line:
  `pnpm admin:token --email you@example.com --name Laptop --scopes mcp:read,mcp:write`.
- **Scopes.** Each tool needs one scope:

  | Scope | Allows |
  |---|---|
  | `mcp:read` | Reading tools such as `project.get` and `project.list` |
  | `mcp:write` | Tools that create or change data, such as `project.create` |
  | `mcp:admin` | Administration tools. Only the owner's tokens carry it |

- **Cookies are ignored.** A signed-in browser session does not authorize `/mcp`, and the REST
  API under `/api` never accepts access tokens.
- **Failures.** A missing, malformed, expired or revoked token gets `401` with a
  `WWW-Authenticate: Bearer` header. Revoking a token in Settings takes effect on its next request.
  Device tokens (`lc_dev_…`) are not accepted.
- **Job tokens.** Producer sessions will receive short-lived `lc_job_…` tokens, bound to the
  project of the job they run. Tools state whether job tokens may call them; until job tokens are
  issued, `/mcp` accepts user tokens (`lc_mcp_…`) only.

## Connecting a client

Most MCP clients take a server entry with a name, a URL and extra request headers. The exact
file and key names differ between clients; a typical entry looks like this:

```json
{
  "mcpServers": {
    "loomcast": {
      "type": "http",
      "url": "https://loomcast.prabhavalabs.com/mcp",
      "headers": {
        "Authorization": "Bearer ${LOOMCAST_MCP_TOKEN}"
      }
    }
  }
}
```

Keep the token in an environment variable or the client's secret store rather than in a file
you share or commit. Choose "streamable HTTP" (sometimes called "HTTP") as the transport, not SSE
or stdio.

To check a token from a terminal:

```bash
curl -s -X POST https://loomcast.prabhavalabs.com/mcp \
  -H "Authorization: Bearer $LOOMCAST_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

And to create a project:

```bash
curl -s -X POST https://loomcast.prabhavalabs.com/mcp \
  -H "Authorization: Bearer $LOOMCAST_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"project.create","arguments":{"name":"Rust in 60 seconds"}}}'
```

## Results and errors

A successful call returns the tool's output as `structuredContent`, matching the output schema
advertised by `tools/list`, and a one-line text summary in `content` that names the ids and slugs a
follow-up call needs.

A failed call returns `isError: true` with one text item of the form `<code>: <message>`, and no
`structuredContent`. Messages never include stack traces or internal details.

| Code | Meaning |
|---|---|
| `forbidden` | The token lacks the tool's scope, the tool does not accept job tokens, or a job token named another project |
| `not_found` | The project (or other record) does not exist |
| `conflict` | The request clashes with existing data, for example a slug already in use |
| `internal` | Something failed on the server; details are in the server log |

Arguments that do not match the input schema are rejected before the tool runs, with an
`Input validation error: …` message.

Errors outside a tool call are plain HTTP statuses: `401` (token), `403` (foreign origin), `405`
(method), `413` (body too large) and `429` (rate limit).

## Auditing

Every tool call is written to the audit log as `mcp.tool.called`, with the token as the actor,
the tool name, the client address and the outcome (`ok`, `denied` or `error`, with the error
code). Arguments and results are not logged. Changes made by a tool, such as `project.created`,
are audited as well, naming the token.

## Tool reference

Generated from the schemas the server advertises; do not edit by hand. After changing a tool,
regenerate it with `UPDATE_MCP_DOCS=1 pnpm --filter @loomcast/api exec vitest run mcp-docs`.

<!-- tool-reference:start -->

### `project.create`

Create a project. The slug is derived from the name unless given. Returns the project and its link.

- **Scope:** `mcp:write`
- **Job tokens:** not allowed
- **Project binding:** the input names no project

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | 1 to 120 characters |
| `slug` | string | no | at most 64 characters; matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| `description` | string | no | at most 2000 characters |

**Output** (`structuredContent`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `project` | object | yes |  |
| `project.id` | string (uuid) | yes |  |
| `project.slug` | string | yes | at most 64 characters; matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| `project.name` | string | yes |  |
| `project.description` | string \| null | yes |  |
| `project.url` | string (uri) | yes |  |

### `project.get`

Get a project by id or slug, with counts of its conversations and content.

- **Scope:** `mcp:read`
- **Job tokens:** allowed
- **Project binding:** the input names the project

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `idOrSlug` | string | yes | 1 to 64 characters |

**Output** (`structuredContent`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `project` | object | yes |  |
| `project.id` | string (uuid) | yes |  |
| `project.slug` | string | yes | at most 64 characters; matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| `project.name` | string | yes |  |
| `project.description` | string \| null | yes |  |
| `project.status` | "active" \| "archived" | yes |  |
| `project.createdAt` | string (date-time) | yes |  |
| `project.updatedAt` | string (date-time) | yes |  |
| `project.archivedAt` | string (date-time) \| null | yes |  |
| `stats` | object | yes |  |
| `stats.conversations` | integer | yes | at least 0 |
| `stats.kbEntries` | integer | yes | at least 0 |
| `stats.items` | integer | yes | at least 0 |

### `project.list`

List projects, optionally filtered by status.

- **Scope:** `mcp:read`
- **Job tokens:** allowed
- **Project binding:** the input names no project

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | "active" \| "archived" | no |  |

**Output** (`structuredContent`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `projects` | object[] | yes |  |
| `projects[].id` | string (uuid) | yes |  |
| `projects[].slug` | string | yes | at most 64 characters; matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| `projects[].name` | string | yes |  |
| `projects[].description` | string \| null | yes |  |
| `projects[].status` | "active" \| "archived" | yes |  |
| `projects[].createdAt` | string (date-time) | yes |  |
| `projects[].updatedAt` | string (date-time) | yes |  |
| `projects[].archivedAt` | string (date-time) \| null | yes |  |

<!-- tool-reference:end -->
