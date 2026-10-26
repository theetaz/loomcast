# Machine API

Loomcast's machine API lets another backend, such as a web app that writes posts, schedule posts
on the workspace's Facebook Pages and Instagram accounts. The backend sends the post (its format,
caption, files and channels) and a time; Loomcast stores the files, puts the post through the
owner's approval when it needs one, and publishes it on every channel at that time. The backend
then reads back each channel's status, permalink, errors and metrics.

The API is served under `/api/v1` on the Loomcast server, for example
`https://loomcast.example.com/api/v1`. It is for servers, not browsers: it answers no CORS
preflight, reads no cookies and needs an API key on every request. Everything here is also in
[`/llms.txt`](../apps/web/public/llms.txt), a single page written for language models.

Contents: [concepts](#concepts), [authentication](#authentication), [rate limits](#rate-limits),
[errors](#errors), [idempotency](#idempotency), [endpoints](#endpoints),
[uploading files](#uploading-files), [formats and platform limits](#formats-and-platform-limits),
[post status](#post-status), [polling](#polling), [examples](#end-to-end-examples) and
[MCP instead of REST](#connecting-through-mcp-instead).

## Concepts

**API client.** The owner creates a client for each backend in the workspace's
**Workspace settings → API clients**. A client has a name, one workspace (the one it was created
in), the channels it may use (each with an access level) and an optional expiry. Its API key
(`lc_api_` followed by 43 letters and digits) is shown once, when the client is created. Revoking
the client stops the key at once. Only the owner manages clients; see the [owner's
guide](guide/api-clients.md).

**Workspace.** Every post a client creates is a content item in the client's workspace, so the
owner sees it in Loomcast next to the studio's own work, with "From an API client" on its
versions.

**Channel.** A connected account Loomcast publishes to: a Facebook Page or an Instagram
professional account (Threads and X channels exist too, and publish Reels only). Each channel
belongs to one workspace; a client can be granted only channels of its own workspace, and
reaches only the ones it was granted. A channel can be `active`, `disconnected`, `needs_reauth`
(the owner has to reconnect it) or `disabled` (nothing is scheduled on it).

**Access levels.** Each granted channel has one level; each level includes the ones before it.

| Level | The client may |
|---|---|
| `read` | List the channel, and read the status, permalinks, errors and metrics of its posts |
| `write` | Also create posts on it and schedule them. Each post waits in the owner's approvals and goes out only once the owner approves it |
| `publish` | Also have its posts approved on the owner's behalf, so they are scheduled straight away |

A post that goes out on several channels needs at least `write` on all of them. It is approved on
the owner's behalf only when the client has `publish` on all of them **and** none of them
requires approval: a channel with **Requires approval** switched on keeps every post for the
owner, whatever the client's level.

**Format.** What a post is: `reel`, `video`, `image` (one photo), `carousel`, `story` or `text`.
Each format carries a fixed number of files of given types, and each platform publishes some
formats only (see [formats and platform limits](#formats-and-platform-limits)).

**Composed post.** A post made from files the client uploads (as opposed to a video the studio
produces). It skips production and goes straight to review, approval and the calendar.

**Dry run and live.** Every channel starts in dry run: Loomcast builds the exact requests it would
send to the platform and records them, but sends nothing. The post still moves to `published`, with
a permalink that starts with `dryrun://` (for example `dryrun://facebook/<postId>`). The owner
switches a channel to live in the workspace's channel settings; the server's publishing mode can
also keep every channel in dry run. Each target says which applies (`dryRun`), fixed when the target
is created.

**Approval.** The owner reviews posts in **Approvals**. Approving queues the post's targets for
their time; asking for changes or rejecting it keeps it off the calendar. A target still waiting
for approval when its time comes is `missed`.

## Authentication

Send the key in the `Authorization` header of every request:

```http
Authorization: Bearer lc_api_...
```

- A missing, malformed, unknown, expired or revoked key gets `401 unauthorized` with
  `WWW-Authenticate: Bearer realm="loomcast"`. So does any other kind of Loomcast token (MCP,
  job or device tokens) and a browser session cookie: they never work here, and an API key never
  works on the web app's routes or on `/mcp`.
- Too many failed keys from one address (30 a minute) get `429` before the key is even looked up.
- `403 forbidden` on every request means the account that owns the client is no longer the
  owner; the owner has to create a new client.
- Keep the key in the backend's secret store. Never put it in a browser or a mobile app.

Requests with a body must send `Content-Type: application/json` (`415` otherwise); bodies are
at most 1 MiB. Every answer is JSON with `Cache-Control: no-store`. Timestamps are ISO 8601 with
an offset, for example `2026-11-02T09:00:00.000Z`. Ids are UUIDs.

## Rate limits

Each client has a bucket of **120 requests**, refilled continuously over **a minute** (two a
second). Every answer carries `RateLimit-Limit` (the bucket size) and `RateLimit-Remaining`.
Past the limit the API answers `429 rate_limited` with `Retry-After` in seconds; wait that long
before the next request. Clients do not share buckets.

## Errors

Every error is JSON:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request is not valid.",
    "details": [{ "path": "channels.1.channelId", "message": "No channel with that id is granted to this API client" }]
  }
}
```

`code` is stable; `message` is a sentence for people; `details` depends on the code. Treat
unknown codes by their HTTP status.

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | The body is not JSON |
| 400 | `validation_failed` | A field is wrong. `details` lists `{path, message}`. A channel that is not granted to the client reads exactly like one that does not exist |
| 401 | `unauthorized` | No usable API key |
| 403 | `forbidden` | The client's level is too low on a granted channel (`details` lists `{path, channelId, access, required}`), the post was created by another client, or the client's owner is no longer the owner |
| 404 | `not_found` | No post with that id that this client can see, or an unknown path |
| 409 | `conflict` | The post is cancelled (`details.reason: "cancelled"`), or it changed meanwhile |
| 409 | `idempotency_conflict` | The `Idempotency-Key` was used before with another body |
| 409 | `upload_missing` | A file is not uploaded yet (`details.reason: "not_uploaded"`) or failed verification (`"failed_verification"`); `details.index` names it |
| 409 | `post_not_editable` | Nothing of the post can move or be cancelled any more: it is publishing, published or cancelled |
| 409 | `invalid_transition` | The post cannot move this way, for example an approval that was withdrawn |
| 413 | `payload_too_large` | The body is over 1 MiB |
| 415 | `unsupported_media_type` | The body is not sent as `application/json` |
| 422 | `format_not_supported` | A channel's platform does not publish the format, or a Facebook carousel has a video. The message names each channel by its index |
| 422 | `missing_artifact` | The files do not fit the format |
| 422 | `media_type_mismatch` | A file's bytes are not what its MIME type says (`details: {index, declared, detected}`) |
| 429 | `rate_limited` | Over the rate limit; see `Retry-After` |
| 500 | `internal` | Loomcast failed; retry with the same `Idempotency-Key` |
| 503 | `storage_unavailable` | The server has no file storage configured |

## Idempotency

`POST /api/v1/posts` takes an optional `Idempotency-Key` header: 1 to 200 visible ASCII
characters, unique per post on the backend's side (an order id, a row id and a version). With a
key:

- The first request that succeeds is remembered for **24 hours** for this client.
- Repeating it with the same key and the same body (compared as canonical JSON: key order and
  spacing do not matter) creates nothing: it answers `201` with the same post, fresh upload URLs
  for the files not uploaded yet and `Idempotent-Replayed: true`.
- The same key with a different body answers `409 idempotency_conflict`.
- A request that fails stores nothing, so it can be retried with the same key.

Send a key whenever a timeout or a crash could make the backend send the same post twice.
`finalize`, `cancel` and `PATCH` are idempotent by themselves.

## Endpoints

| Method and path | Needs | What it does |
|---|---|---|
| `GET /api/v1/me` | any key | The client, its workspace, its grants and the rate limit |
| `GET /api/v1/channels` | any key | The granted channels, with access and formats |
| `GET /api/v1/formats` | any key | What each format carries and which platforms publish it |
| `POST /api/v1/posts` | `write` on every channel | Creates a post; returns upload URLs |
| `GET /api/v1/posts` | any key | The posts the client can see, newest first, by cursor |
| `GET /api/v1/posts/:id` | sees the post | One post |
| `POST /api/v1/posts/:id/uploads` | created it | Fresh upload URLs for files not uploaded yet |
| `POST /api/v1/posts/:id/finalize` | created it, `write` | Verifies the files, then submits and schedules the post |
| `PATCH /api/v1/posts/:id` | created it, `write` | Moves every open target to a new time |
| `POST /api/v1/posts/:id/cancel` | created it, `write` | Withdraws every open target |
| `GET /api/v1/posts/:id/metrics` | sees the post | The latest metrics of each published target |

**Which posts a client sees.** A client sees every post it created, with all of its targets, and
every post on a channel it is granted at any level (created in Loomcast or by another client),
with only the targets on its granted channels and without the other client's `externalRef`. It
can change only the posts it created (`own: true`); for any other post the change routes answer
`403`. A post the client cannot see answers `404`, the same as one that does not exist.

The examples use these shell variables:

```bash
export LOOMCAST_API=https://loomcast.example.com/api/v1
export LOOMCAST_API_KEY=lc_api_...   # from Workspace settings → API clients
```

### `GET /api/v1/me`

```bash
curl -s "$LOOMCAST_API/me" -H "Authorization: Bearer $LOOMCAST_API_KEY"
```

```json
{
  "client": {
    "id": "6f1c…",
    "name": "Blog backend",
    "prefix": "lc_api_3fKq9ZtA",
    "createdAt": "2026-10-18T08:00:00.000Z",
    "expiresAt": null
  },
  "workspace": { "id": "0b1c…", "slug": "release-notes", "name": "Release notes" },
  "project": { "id": "0b1c…", "slug": "release-notes", "name": "Release notes" },
  "grants": [
    { "channelId": "a3e1…", "access": "publish" },
    { "channelId": "c97d…", "access": "write" }
  ],
  "rateLimit": { "requests": 120, "perSeconds": 60 }
}
```

`project` repeats `workspace` for clients written before projects were renamed workspaces. It is
deprecated; read `workspace`.

### `GET /api/v1/channels`

```json
{
  "items": [
    {
      "id": "a3e1…",
      "platform": "facebook",
      "name": "Loomcast",
      "username": null,
      "status": "active",
      "dryRun": false,
      "requiresApproval": false,
      "access": "publish",
      "formats": ["reel", "video", "image", "carousel", "story", "text"]
    },
    {
      "id": "c97d…",
      "platform": "instagram",
      "name": "Loomcast",
      "username": "loomcast.dev",
      "status": "active",
      "dryRun": true,
      "requiresApproval": false,
      "access": "write",
      "formats": ["reel", "image", "carousel", "story"]
    }
  ]
}
```

`dryRun` is true when either the channel or the server publishes in dry run.

### `GET /api/v1/formats`

The tables of [formats and platform limits](#formats-and-platform-limits) as JSON: `formats`
(each with `label`, `min`, `max`, `types` and `platforms`), `platforms` (each with its
`formats`), `mediaTypes` (the MIME types of photos and videos), `photoOnlyCarouselPlatforms` and
`options` (every per-platform option with its type and the formats it applies to). It is the
same document as the MCP tool `post.formats`.

### `POST /api/v1/posts`

Creates a post. Headers: `Authorization`, `Content-Type: application/json` and, recommended,
`Idempotency-Key`.

| Field | Type | |
|---|---|---|
| `format` | `"reel" \| "video" \| "image" \| "carousel" \| "story" \| "text"` | Required |
| `title` | string, 1 to 200 | Shown in Loomcast only. Defaults to the caption's first line |
| `caption` | string, up to 2,200 | The text of the post. Required for `text`. Stories show no caption |
| `media` | array of files, up to 10, in order | See below. Must fit the format; `text` takes none |
| `channels` | array of `{channelId, options?}`, 1 to 50 | Each channel once. `options` per platform, below |
| `scheduledAt` | timestamp | At least two minutes ahead |
| `externalRef` | string, 1 to 200 | The backend's own reference, returned as given |

Each file of `media`:

| Field | Type | |
|---|---|---|
| `filename` | string, 1 to 255, no folders | |
| `mime` | `image/jpeg`, `image/png`, `image/webp`, `video/mp4` or `video/quicktime` | Checked against the file's leading bytes on finalize |
| `bytes` | integer, 1 to 1 GiB | The exact size |
| `sha256` | 64 hex characters | SHA-256 of the bytes; checked on upload and on finalize |
| `width`, `height` | integers, pixels | Required for videos; recommended for photos (Instagram checks width and aspect ratio) |
| `durationMs` | integer, milliseconds | Required for videos; not allowed on photos |
| `altText` | string, up to 1,000 | What a photo shows, for screen readers (Instagram and Facebook photos) |

A file appears once per post (by `sha256`).

`options`, per channel:

| Option | Type | Formats | |
|---|---|---|---|
| `instagram.shareToFeed` | boolean | `reel` | Also show the Reel in the profile grid. Defaults to true |
| `instagram.collaborators` | up to 3 usernames | `reel`, `image`, `carousel` | Invited as collaborators |
| `instagram.locationId` | digits | `reel`, `image`, `carousel` | A Facebook Page id used as the location |
| `instagram.thumbOffsetMs` | integer | `reel` | The cover frame, in ms from the start |
| `facebook.link` | http(s) URL | `text` | Shown as a link preview card |
| `facebook.title` | string, up to 255 | `video` | Shown above the video |

The API checks before it stores anything: the client's level on every channel, that each
platform publishes the format (and, for Facebook carousels, that every file is a photo), that the
files fit the format, and the lead time. A refusal names every offending field at once.

```bash
curl -s -X POST "$LOOMCAST_API/posts" \
  -H "Authorization: Bearer $LOOMCAST_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: article-1842-v1" \
  -d '{
    "format": "image",
    "caption": "Version 2.4 is out: faster renders and dark mode.",
    "media": [{
      "filename": "release.jpg",
      "mime": "image/jpeg",
      "bytes": 482113,
      "sha256": "9f2c1d0e5b7a4c3e8f6a1b2c3d4e5f60718293a4b5c6d7e8f901122334455667",
      "width": 1080,
      "height": 1350,
      "altText": "The release notes on a laptop screen"
    }],
    "channels": [
      { "channelId": "c97d…", "options": { "instagram": { "collaborators": ["loomcast.team"] } } },
      { "channelId": "a3e1…" }
    ],
    "scheduledAt": "2026-11-02T09:00:00.000Z",
    "externalRef": "article-1842"
  }'
```

`201 Created` with the [post](#the-post-resource) and its uploads:

```json
{
  "id": "5d0e…",
  "externalRef": "article-1842",
  "own": true,
  "format": "image",
  "title": "Version 2.4 is out: faster renders and dark mode.",
  "caption": "Version 2.4 is out: faster renders and dark mode.",
  "status": "awaiting_media",
  "scheduledAt": "2026-11-02T09:00:00.000Z",
  "media": [
    { "mediaId": "e41b…", "type": "image", "altText": "The release notes on a laptop screen", "status": "pending" }
  ],
  "targets": [
    { "channelId": "c97d…", "platform": "instagram", "postId": null, "status": null, "scheduledAt": "2026-11-02T09:00:00.000Z", "permalink": null, "externalId": null, "lastError": null, "publishedAt": null, "dryRun": true },
    { "channelId": "a3e1…", "platform": "facebook", "postId": null, "status": null, "scheduledAt": "2026-11-02T09:00:00.000Z", "permalink": null, "externalId": null, "lastError": null, "publishedAt": null, "dryRun": false }
  ],
  "createdAt": "2026-10-18T10:00:00.000Z",
  "updatedAt": "2026-10-18T10:00:00.000Z",
  "uploads": [
    {
      "mediaId": "e41b…",
      "url": "https://<storage>/…?X-Amz-Signature=…",
      "method": "PUT",
      "headers": {
        "Content-Type": "image/jpeg",
        "Content-Length": "482113",
        "x-amz-checksum-sha256": "nywdDlt6TD6PahssPU5fYHGCk6S1xtfo+QESIjNEVWZ3"
      },
      "expiresAt": "2026-10-18T10:15:00.000Z"
    }
  ]
}
```

Then [upload the files](#uploading-files) and call `finalize`. A `text` post has no files: it
is submitted and scheduled in the same request, and the answer already has its targets
(`status: "scheduled"` with `publish` access, `"pending_approval"` otherwise) and `uploads: []`.

### `POST /api/v1/posts/:id/uploads`

Upload URLs live 15 minutes. This returns the post with fresh `uploads` for every file that is
not uploaded and verified yet (and none once the post is finalized). A file that failed
verification starts over here.

### `POST /api/v1/posts/:id/finalize`

No body (or `{}`). After every file is uploaded, finalize:

1. checks each file in order: it is stored, its size and SHA-256 match, and its leading bytes are
   those of its declared MIME type (`409 upload_missing` or `422 media_type_mismatch` otherwise;
   nothing changes);
2. writes the post's version with the files in order and their alt texts, and submits it;
3. with `publish` on every channel and no channel that requires approval, approves it on the
   owner's behalf (the review names the client) and queues a target per channel; otherwise
   creates the targets as `planned`, waiting in the owner's approvals;
4. does steps 2 and 3 in one transaction: if any channel is refused (it was disabled meanwhile,
   or the time is now less than two minutes ahead), nothing is scheduled.

It answers `200` with the post. Finalizing a finalized post returns it unchanged. When the time
passed while the files uploaded, `PATCH` the post to a new time and finalize again.

### `GET /api/v1/posts/:id`

The [post](#the-post-resource). `404` when the client cannot see it.

### `GET /api/v1/posts`

Query parameters, all optional:

| Parameter | |
|---|---|
| `channelId` | Posts with a target on this granted channel (`400` for a channel not granted) |
| `status` | One [post status](#post-status) |
| `from`, `to` | Posts whose `scheduledAt` is at or after `from` and before `to` |
| `limit` | 1 to 100, default 50 |
| `cursor` | The `nextCursor` of the previous page |

```json
{ "items": [ { "id": "5d0e…", "status": "scheduled" } ], "nextCursor": "eyJjcmVhdGVkQXQiOi…" }
```

Posts come newest first (by creation). `nextCursor` is null on the last page; cursors are
opaque.

### `PATCH /api/v1/posts/:id`

```json
{ "scheduledAt": "2026-11-03T09:00:00.000Z" }
```

Moves every target that has not gone out (`planned`, `queued`, `failed` or `missed`) to the new
time, at least two minutes ahead, in one transaction; a `failed` or `missed` target is tried
again. Before finalize it changes the requested time. `409 post_not_editable` when nothing is
left to move.

### `POST /api/v1/posts/:id/cancel`

Withdraws every target that has not gone out. When none is publishing or published, the post is
`cancelled` and its item is archived in Loomcast, out of the owner's approvals and calendar.
Targets already live stay live: Loomcast never deletes a published post. Cancelling a cancelled
post returns it.

### `GET /api/v1/posts/:id/metrics`

```json
{
  "id": "5d0e…",
  "targets": [
    {
      "channelId": "c97d…",
      "platform": "instagram",
      "postId": "8a2f…",
      "metrics": { "capturedAt": "2026-11-03T09:00:00.000Z", "views": 1840, "likes": 122, "comments": 9, "shares": 14, "saves": 31, "reach": 1502, "avgWatchMs": null }
    }
  ]
}
```

One entry per published target. Loomcast captures the insights of live posts on a decaying
schedule after they go out; `metrics` is null until the first capture and for dry-run posts. A
count the platform does not report is null.

### The post resource

| Field | |
|---|---|
| `id` | The post's id (its content item in Loomcast) |
| `externalRef` | As sent; null on posts of other clients |
| `own` | Whether this client created it; only those can change |
| `format`, `title`, `caption` | |
| `status` | The [post status](#post-status) |
| `scheduledAt` | The earliest time of its targets that have not gone out, else of its targets; the requested time before finalize |
| `media[]` | `{mediaId, type, altText, status}` in order; `status` is `pending`, `ready` or `failed` |
| `targets[]` | One per channel (and one per attempt after a cancel and a new post), oldest time first |
| `targets[].postId` | The scheduled post's id; null before finalize |
| `targets[].status` | `planned`, `queued`, `publishing`, `published`, `failed`, `cancelled` or `missed`; null before finalize |
| `targets[].permalink` | The live post's address once published (`dryrun://…` in dry run) |
| `targets[].externalId` | The platform's id of the post |
| `targets[].lastError` | Why the last attempt failed: `{code, message, retryable, platformCode?, retryAfterMs?}` |
| `targets[].publishedAt`, `targets[].dryRun` | |
| `createdAt`, `updatedAt` | `updatedAt` moves with every change to the item or a target |

## Uploading files

Files never pass through the API. For each entry of `uploads`, in any order, `PUT` the exact
bytes to `url` with **exactly** the headers given; they are part of the signature, so the store
refuses anything else:

- `Content-Type`: the declared MIME type;
- `Content-Length`: the declared size;
- `x-amz-checksum-sha256`: the SHA-256 of the bytes, base64-encoded (the hex digest sent in
  `sha256`, as raw bytes, in base64). The store rejects a body whose checksum differs.

```bash
# The hex digest for "sha256" when creating the post:
shasum -a 256 release.jpg | cut -d' ' -f1
# The base64 digest the store checks (it is also in the upload's headers):
openssl dgst -sha256 -binary release.jpg | base64

curl -s -X PUT "$UPLOAD_URL" \
  -H "Content-Type: image/jpeg" \
  -H "Content-Length: 482113" \
  -H "x-amz-checksum-sha256: nywdDlt6TD6PahssPU5fYHGCk6S1xtfo+QESIjNEVWZ3" \
  --data-binary @release.jpg
```

A `200` from the store means the bytes arrived; Loomcast checks them again on finalize. URLs
expire after 15 minutes (`expiresAt`); ask for new ones with `POST /posts/:id/uploads`. A file
whose bytes do not match fails verification and must be uploaded again; one whose bytes are of
another type than declared cannot be fixed: cancel the post and create it again with the right
`mime`.

In Node.js:

```js
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const bytes = await readFile("release.jpg");
const sha256 = createHash("sha256").update(bytes).digest("hex");
// ... create the post with { filename, mime: "image/jpeg", bytes: bytes.length, sha256 } ...
for (const upload of post.uploads) {
  const response = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: bytes });
  if (!response.ok) throw new Error(`upload failed with ${response.status}`);
}
```

## Formats and platform limits

What each format carries (`GET /formats` returns the same):

| Format | Files | Facebook Page | Instagram | Threads, X |
|---|---|---|---|---|
| `reel` | 1 video | yes | yes | yes |
| `video` | 1 video | yes | no | no |
| `image` | 1 photo | yes | yes | no |
| `carousel` | 2 to 10 photos or videos (Facebook: photos only) | yes | yes | no |
| `story` | 1 photo or video | yes | yes | no |
| `text` | none; a caption, and on Facebook optionally a link | yes | no | no |

The platforms' own limits are checked when the post goes out (the request builders in
`apps/api/src/modules/publisher/requests/instagram.ts` and `facebook.ts`, confirmed against
Graph API v26.0 on 2026-10-18). A file outside them fails its target with
`lastError.code: "invalid_media"` and a message that names the limit, so check them before
uploading:

| Platform and format | Types | Size | Duration | Dimensions |
|---|---|---|---|---|
| Instagram Reel | MP4, MOV | 300 MB | 3 s to 15 min | at most 1920 px wide; aspect 0.01:1 to 10:1 |
| Instagram photo and carousel photo | JPEG only | 8 MB | | at least 320 px wide; aspect 4:5 to 1.91:1 |
| Instagram carousel video | MP4, MOV | 100 MB | 3 to 60 s | |
| Instagram carousel | 2 to 10 items | | | |
| Instagram story photo | JPEG only | 8 MB | | 9:16 recommended |
| Instagram story video | MP4, MOV | 100 MB | 3 to 60 s | aspect 0.1:1 to 10:1 |
| Facebook Reel | MP4, MOV | 1 GB | 3 to 90 s | 9:16, at least 540 × 960 |
| Facebook video | MP4, MOV | 1 GB | 1 s to 20 min | |
| Facebook photo, carousel photo and story photo | JPEG, PNG (not WebP) | 4 MB | | |
| Facebook story video | MP4, MOV | 1 GB | 3 to 60 s | 9:16, at least 540 × 960 |
| Facebook text post | | | | needs a caption or a link |

Captions: Instagram takes up to 2,200 characters with at most 30 hashtags and 20 mentions;
Facebook up to 2,200 characters here. A longer caption is cut on a word boundary. Stories take no
caption. Alt text is sent for Instagram and Facebook photos. Instagram counts a carousel as one
post against its daily publishing limit.

So a photo for both an Instagram account and a Facebook Page should be a JPEG of at most 4 MB, at
least 320 px wide, between 4:5 and 1.91:1.

## Post status

```
            create
              │
       awaiting_media ──finalize──┬── publish on every channel ──▶ scheduled ──▶ publishing ──▶ published
              │                    │                                   ▲                      ├─▶ partially_published
              │                    └── otherwise ──▶ pending_approval ─┘ owner approves        └─▶ failed
              │                                           │
              └──────────── cancel ───────────────────────┴──▶ cancelled
```

| Status | Meaning |
|---|---|
| `awaiting_media` | Created; `finalize` has not succeeded yet |
| `pending_approval` | Waiting in the owner's approvals (a target is `planned`) |
| `scheduled` | Approved; at least one target is `queued` for its time |
| `publishing` | At least one target is going out, or the platform is still processing it |
| `published` | Every target that was not cancelled is published |
| `partially_published` | Some targets published, others `failed` or `missed` |
| `failed` | No target published: each `failed` (see `lastError`) or `missed` |
| `cancelled` | Withdrawn by the client, rejected by the owner, or every target cancelled |

A target is `missed` when its time came before the owner approved it. A `queued` target can
carry a `lastError` with code `rate_limited` while it waits for the platform's or Loomcast's
publishing limits (for example Instagram's 50 posts a day); it goes out as soon as the window
allows. A `failed` target with
`lastError.retryable: true` was retried by Loomcast before it gave up; `PATCH` the post to try
again later. If the owner asks for changes, the post goes back into Loomcast's production and its
targets wait as `planned` until it is approved again.

## Polling

There are no webhooks. Read a post's state with `GET /posts/:id` (one request per post) or many
at once with `GET /posts?status=…` or `?from=…&to=…`:

- Until the scheduled time, poll rarely (every few minutes is plenty) or not at all.
- From the scheduled time, poll every 30 to 60 seconds until no target is `queued` or
  `publishing`. Videos can stay `publishing` for several minutes while the platform processes
  them.
- Then read `metrics` a few times a day if you need them.
- Stay well inside the 120 requests a minute, and honour `Retry-After`.

## End-to-end examples

### A photo on an Instagram account and a Facebook Page

1. `POST /posts` with `format: "image"`, one JPEG under 4 MB and both channels (see the example
   above). Keep `id` and `uploads`.
2. `PUT` the file to `uploads[0].url` with `uploads[0].headers`.
3. `POST /posts/{id}/finalize`. With `publish` on both channels the answer is `scheduled` with
   two `queued` targets; with `write` it is `pending_approval`.
4. After `scheduledAt`, poll `GET /posts/{id}` until both targets are `published`, then store
   their `permalink`s.

### A carousel

```bash
curl -s -X POST "$LOOMCAST_API/posts" \
  -H "Authorization: Bearer $LOOMCAST_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: gallery-77" \
  -d '{
    "format": "carousel",
    "caption": "Three steps to a faster build.",
    "media": [
      { "filename": "step-1.jpg", "mime": "image/jpeg", "bytes": 301822, "sha256": "<hex>", "width": 1080, "height": 1350, "altText": "Step one: cache the lockfile" },
      { "filename": "step-2.jpg", "mime": "image/jpeg", "bytes": 288400, "sha256": "<hex>", "width": 1080, "height": 1350 },
      { "filename": "step-3.mp4", "mime": "video/mp4", "bytes": 8811200, "sha256": "<hex>", "width": 1080, "height": 1350, "durationMs": 14000 }
    ],
    "channels": [{ "channelId": "<instagram channel>" }],
    "scheduledAt": "2026-11-02T12:00:00.000Z"
  }'
```

Upload the three files, then finalize. The carousel keeps the order of `media`. On a Facebook
Page a carousel must be photos only; a video there is refused with `422 format_not_supported`.

### A story

`format: "story"` with one photo (JPEG for Instagram) or one video (with `width`, `height` and
`durationMs`, 3 to 60 seconds). Stories take no caption, collaborators or location; anything sent
there is ignored.

### A Facebook link post

```bash
curl -s -X POST "$LOOMCAST_API/posts" \
  -H "Authorization: Bearer $LOOMCAST_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: article-1843-fb" \
  -d '{
    "format": "text",
    "caption": "How we cut our render times in half.",
    "channels": [{ "channelId": "<facebook page>", "options": { "facebook": { "link": "https://example.com/blog/render-times" } } }],
    "scheduledAt": "2026-11-02T15:00:00.000Z",
    "externalRef": "article-1843"
  }'
```

There is nothing to upload: the answer is already `scheduled` (or `pending_approval`). Instagram
does not publish text posts (`422 format_not_supported`).

### Moving and withdrawing

```bash
curl -s -X PATCH "$LOOMCAST_API/posts/$POST_ID" \
  -H "Authorization: Bearer $LOOMCAST_API_KEY" -H "Content-Type: application/json" \
  -d '{ "scheduledAt": "2026-11-04T09:00:00.000Z" }'

curl -s -X POST "$LOOMCAST_API/posts/$POST_ID/cancel" -H "Authorization: Bearer $LOOMCAST_API_KEY"
```

## Connecting through MCP instead

Loomcast also serves its tools over the Model Context Protocol at `/mcp` (see [mcp.md](mcp.md)).
MCP suits an assistant or a tool that works as a person would; the REST API suits a backend that
schedules posts unattended. They use different credentials:

- Create an MCP access token in **Account settings → Access tokens** (`lc_mcp_…`). Composing and
  scheduling posts over MCP needs the owner's token with the `mcp:admin` scope; it acts as the
  owner, with every channel, and its posts are approved as the owner's own review.
- An API key does not work on `/mcp`, and an MCP token does not work on `/api/v1`.

The MCP flow for the same photo: `post.formats` (what each format takes), `channel.list`
(`workspaceId`, for that workspace's channels), `post.create` (`workspaceId`, `title`,
`format: "image"`, `caption`), `content.upload_asset` (`kind: "media"`, the post's `itemId`), `PUT`
the bytes, `content.finalize_asset`, `post.compose` (`media: [{assetId, altText}]`), then
`post.schedule` (`itemId`, `channelIds`, `scheduledAt`, `options`). `calendar.list_posts`,
`calendar.reschedule_post` and `calendar.cancel_post` follow the posts afterwards.

## Auditing

Every write request (`POST /posts`, `uploads`, `finalize`, `PATCH` and `cancel`) appends one
`api.request` row to Loomcast's audit log with the client as the actor and the post as the
target. The changes the client makes in the owner's name (the item, its version, the review and
the scheduled posts) are audited as well, so the owner can follow every post back to the client.
Keys are never logged or audited.
