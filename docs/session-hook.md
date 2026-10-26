# Session-end hook

`apps/studio-agent/hooks/session-end.mjs` files a summary of a finished working session in a
workspace's knowledge base, as a **Session summary** entry. It works with any client that runs a
session-end hook with a JSON payload on stdin.

It is optional and off by default. It is plain Node (22.12 or newer) with no dependencies and no
build step, so it runs straight from the repository checkout.

## What it sends

When a session ends, the client runs the hook and writes a payload like this to its stdin:

```json
{ "session_id": "…", "transcript_path": "/…/session.jsonl", "cwd": "/…" }
```

The hook reads the transcript (JSON Lines, one message per line) and builds a short markdown
digest:

- a heading taken from the first prompt, which becomes the entry's title
  (`Session summary: …`);
- the session id, its duration (first to last timestamp) and the number of messages;
- the working directory;
- the first user prompt, up to 600 characters (messages the client marks as injected context
  are skipped);
- the last assistant message, up to 3,000 characters;
- up to 50 files the session edited, relative to the working directory where possible;
- how often each tool was used.

Before anything leaves the machine it redacts:

- Loomcast tokens (`lc_…`);
- secret keys shaped like `sk-…`, cloud access key ids (`AKIA…`, `ASIA…`), source-hosting tokens
  (`ghp_…` and the related prefixes) and chat-workspace tokens;
- bearer tokens after `Bearer`;
- every line that sets a password (`password=`, `password:` and similar), replaced as a whole.

It then calls the `kb.save_session_summary` MCP tool on `<LOOMCAST_URL>/mcp` with
`sessionId`, `summaryMd`, `cwd` and, when known, `workspaceId`. The full transcript is never sent.
Calling it again for the same session replaces that session's summary.

## Guarantees

- **It never fails a session.** It always exits 0, whatever goes wrong, and reports only one line
  on stderr (`[loomcast hook] saved: …`, `skipped: …` or `failed: …`).
- **It never holds a session up for long.** The server gets 5 seconds, including the response;
  stdin is read for at most 2 seconds; a watchdog ends the process after 9 seconds.
- **It never prints or stores the token.** The token is only sent as a bearer header, and only
  over `https` (plain `http` is accepted for `localhost`, `127.0.0.1` and `[::1]` only).
- It accepts JSON and server-sent-event answers from the MCP endpoint.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `LOOMCAST_SESSION_HOOK` | yes | `1` (or `true`, `on`, `yes`) turns the hook on; anything else and it exits at once |
| `LOOMCAST_URL` | yes | The Loomcast server, for example `https://loomcast.example.com`; `/mcp` is added unless the URL already ends with it |
| `LOOMCAST_MCP_TOKEN` | yes | An access token with **Write** (`mcp:write`), from **Account settings → Access tokens** |
| `LOOMCAST_WORKSPACE_ID` | no | The workspace to file summaries in |

The variables must be in the environment the client starts its hooks with, for example the
shell profile of the user who runs the client. Job tokens cannot call this tool.

### Which workspace

The first of these that names a workspace wins:

1. `LOOMCAST_WORKSPACE_ID`.
2. The nearest `.loomcast/workspace.json` at or above the session's working directory:

   ```json
   { "workspaceId": "2d8e4b9a-af6c-4e3a-9b5d-4c3f6a7b8c92" }
   ```

   The nearest file decides: if it is unreadable or names no valid id, no workspace is sent.
3. On the server: a `Loomcast/projects/<workspace id>` folder in the working directory, which is
   where the studio agent keeps each workspace's files. The folder keeps its `projects` name from
   before projects were renamed workspaces.

If none applies, the server answers `workspace_unresolved` and the hook reports
`failed: workspace_unresolved: …`.

Hooks set up before the rename used `LOOMCAST_PROJECT_ID` and `.loomcast/project.json` with a
`projectId` key. The hook no longer reads those names: rename them to `LOOMCAST_WORKSPACE_ID` and
`.loomcast/workspace.json` with `workspaceId`, or the summary falls back to the folder rule.

## Installing

`install.mjs`, next to the hook, prints the hook entry and the environment lines:

```bash
node apps/studio-agent/hooks/install.mjs --url https://loomcast.example.com
```

The entry runs the hook with the absolute path of the current Node binary, in the common
settings shape `{"hooks": {"SessionEnd": [{"hooks": [{"type": "command", "command": "…"}]}]}}`.
Clients that configure hooks differently only need that command for their session-end event.

To merge the entry into a client's JSON settings file:

```bash
node apps/studio-agent/hooks/install.mjs --write path/to/settings.json
```

- The previous file is copied to `settings.json.bak` before it is replaced; a missing file is
  created.
- An existing entry for `session-end.mjs` is updated in place, so running it again changes
  nothing.
- Other keys and hooks are kept. A file that is not valid JSON is left alone and reported.

The environment lines are only printed: the token never goes into a settings file. Add them to
the environment the client runs hooks with and paste the token there.

## Checking it

With the hook off, it does nothing and exits 0:

```bash
echo '{}' | node apps/studio-agent/hooks/session-end.mjs; echo $?
```

With it on, against a local stack (`pnpm dev`) and a token with Write:

```bash
export LOOMCAST_SESSION_HOOK=1 LOOMCAST_URL=http://localhost:5173
export LOOMCAST_WORKSPACE_ID=<workspace id>   # the id, from the MCP tool workspace.list
read -rs LOOMCAST_MCP_TOKEN && export LOOMCAST_MCP_TOKEN
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Plan the DNS explainer"}}' > /tmp/session.jsonl
echo '{"session_id":"try-1","transcript_path":"/tmp/session.jsonl","cwd":"'"$PWD"'"}' \
  | node apps/studio-agent/hooks/session-end.mjs
```

It prints `[loomcast hook] saved: saved session summary <entry id>`, and the entry appears in
the workspace's **Knowledge** page under **Sessions** without a reload.

| Message | Cause |
|---|---|
| `skipped: LOOMCAST_URL and LOOMCAST_MCP_TOKEN are required` | One of them is missing from the hook's environment |
| `skipped: LOOMCAST_URL must use https …` | Plain `http` to another machine; use `https` |
| `skipped: the payload names no session_id` | The client sent no payload, or one without `session_id` |
| `failed: HTTP 401` | The token is missing, mistyped or revoked |
| `failed: forbidden: …` | The token lacks Write |
| `failed: workspace_unresolved: …` | No workspace could be found; see [Which workspace](#which-workspace) |
| `failed: timeout` | The server did not answer within 5 seconds |

## Tests

```bash
pnpm --filter @loomcast/studio-agent exec vitest run hooks
```

The tests cover the digest, redaction (with secret-shaped samples assembled at run time),
workspace resolution, the installer and the timeout, using synthetic transcripts and an
in-process MCP server. `pnpm test:e2e` runs the hook against the real API as well.
