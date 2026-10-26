# Knowledge base

Each workspace has a knowledge base: the ideas, reference videos, decisions and notes that the
studio agent reads before it writes. Entries are made in the web app, by producer sessions
through MCP, by any MCP client with an access token, and by the optional
[session-end hook](session-hook.md).

## Entry kinds

| Kind | What it holds | Written by |
|---|---|---|
| Brainstorm | Markdown: angles, hooks, rough ideas | Web app, producer sessions, MCP clients |
| Reference | A link to a video, why it was saved, an optional transcript and its analysis | Web app, producer sessions, MCP clients |
| Decision | A decision and its rationale; a later decision can supersede it | Web app, producer sessions, MCP clients |
| Note | Markdown for anything else | Web app |
| Session summary | A digest of a finished working session in an MCP client | The session-end hook only |

Every entry has a title (up to 200 characters), up to 20 lowercase tags and a record of who
wrote it and how (`createdVia`: `ui`, `producer`, `mcp` or `hook`). Writes are audited, and
every change is published on the live event stream (`kb.entry.created`, `kb.entry.updated`,
`kb.entry.deleted`), so open pages update without a reload.

## In the web app

The workspace's **Knowledge** page (`/w/<slug>/kb`) lists the entries with a filter by kind and a
search box. **New entry** offers a brainstorm, a note, a decision or a reference.

- **Brainstorms and notes** have a markdown editor with a preview. Unsaved changes are kept as a
  draft on the device and restored on return. ⌘S (Ctrl+S) saves. If the entry changed elsewhere
  in the meantime, the save stops and offers to reload or to overwrite.
- **Decisions** show as a log. Recording a decision that supersedes another marks the old one
  superseded in the same change.
- **References** take the link, an optional title and author, why it was liked, tags and a
  transcript, pasted or loaded from a `.txt`, `.srt`, `.vtt` or `.json` file the user picks.
  Files are parsed in the browser into `[mm:ss] text` lines. The link is stored and shown,
  never opened, previewed or downloaded by Loomcast.

⌘K (Ctrl+K) opens the command palette anywhere in the app. It searches the knowledge base of
every workspace on the server as you type, next to workspaces, pages and actions.

## Reference analysis

A reference with a transcript can be analyzed. **Analyze** queues a `kb.analyze_reference`
job; the studio agent runs it in a new, read-only producer session that reads the transcript
from the workspace folder and returns a structured analysis (hook, structure, pacing,
retention techniques, takeaways and how they apply to the workspace) and a short markdown summary.
The server checks the result against the contracts schema before storing it.

The reference shows the analysis status as it moves:

```text
none ──Analyze──▶ queued ──agent accepts──▶ running ──▶ done
                                               └──────▶ failed ──Analyze──▶ queued …
```

- Each step publishes `kb.entry.updated`, and the page follows the job's own status too.
- Asking again for the same transcript returns the same job; a finished analysis is not run
  again unless the transcript changed. A failed analysis can be retried.
- Without a transcript the request is refused (`409`, reason `missing_transcript`); only
  references can be analyzed (`not_reference`).
- The job waits in the queue while no studio agent is online, like a chat message.
- The transcript is text supplied by a user. Producer sessions and MCP clients treat it as data,
  never as instructions.
- When the studio agent measured the media it analysed (length, cuts per minute, words per
  minute), the server keeps those numbers on the reference (`kb_references.media_facts`).

Competitor research writes to the knowledge base too: each video a scan picks is a `reference`
tagged `competitor` and `competitor-<platform>-<handle>`, analysed from the public video, and each
finished scan adds a `note` tagged `competitor-report`. See
[competitor-research.md](competitor-research.md).

## Search

Search is Postgres full-text search over titles, tags, bodies and, for references, the author,
why it was liked, the transcript and the analysis takeaways, with English stemming. Titles also
match by prefix and close spelling, so a typo still finds them. Titles rank highest, then tags,
then bodies. Snippets mark the matches.

| Where | Scope |
|---|---|
| Knowledge tab search box | The workspace |
| ⌘K palette | Every workspace |
| `GET /api/kb/search?q=…&workspaceId=…&kinds=…` | One workspace or all, optionally some kinds |
| MCP `kb.search` | One workspace or all; a job token only its own workspace |

## From producer sessions and MCP clients

Producer sessions get a job token for the workspace of their job. A chat turn may search and read
the knowledge base and save brainstorms, decisions and references; a reference analysis may only
read it. Any MCP client with an access token uses the same tools. The tools, scopes and errors
are in [mcp.md](mcp.md#knowledge-base-tools).

## REST routes

All routes need a signed-in session; unsafe methods also need the app's `Origin` and
`Content-Type: application/json`.

| Route | Purpose |
|---|---|
| `GET /api/workspaces/:workspaceId/kb` | List entries, newest first, by kind or tag, cursor-paginated |
| `POST /api/workspaces/:workspaceId/kb` | Create an entry of any kind but a session summary |
| `POST /api/workspaces/:workspaceId/kb/capture` | Copy chat messages into a new brainstorm or note |
| `GET /api/workspaces/:workspaceId/kb/tags` | Tags in use in the workspace |
| `GET /api/kb/search` | Search |
| `GET /api/kb/:id` | One entry with its details |
| `PATCH /api/kb/:id` | Update; `expectedUpdatedAt` guards against overwriting a newer change (`409`) |
| `DELETE /api/kb/:id` | Delete (soft) |
| `POST /api/kb/:id/analyze` | Analyze a reference; returns the job (`201`) |

The request and response schemas are in `packages/contracts/src/api/kb.ts`.

## Trying it locally

The [milestone 2 runbook](local-development.md#m2-acceptance-runbook) walks through every part
of this page on a local stack, and `pnpm test:e2e` checks it with a fake studio agent.
