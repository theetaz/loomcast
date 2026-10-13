# Scheduling and publishing

A series publishes on a **cadence**. The server turns each slot of that cadence into an item and a
**post** on each of the series' channels, and starts production ahead of the slot. Approval rules
decide whether a person has to approve the video. At the slot the **publisher** sends the post, or,
in dry-run, records exactly what it would send. This guide covers the cadence model, the approval
rules, the dry-run switches, failures and dead letters, and time zones. The
[pipeline guide](pipeline.md) covers how an item is produced and reviewed.

Most of this runs as scheduled tasks on the API, never on the studio agent:

| Task | Runs | Does |
|---|---|---|
| `cadence.plan` | Every hour for every series; at once for a series whose format or channels change | Turns slots into items, posts and the two tasks below |
| `cadence.produce` | `leadTimeHours` before an item's slot | Starts production through review (autopilot) |
| `post.publish` | At a post's time | Sends the post, or records it in dry-run |
| `post.check_status` | While a platform is processing a live post | Polls until it is live (15 s, backing off to 60 s; it gives up after 20 minutes) |

Production itself still runs on the studio agent as jobs, exactly as in the pipeline guide.

## Cadence

A format's rules carry the cadence and the publish mode (`packages/contracts/src/pipeline/format-rules.ts`):

```json
"cadence": { "days": ["mon", "wed", "fri"], "slots": ["09:00"], "tz": "UTC", "leadTimeHours": 24 },
"publishMode": "approval"
```

- `days` and `slots` are local weekdays and `HH:mm` times in `tz`, an IANA time zone. Each time on
  each day is one slot. No days or no times means no slots.
- `leadTimeHours` (1 to 336) is how long before its slot an item's production starts.
- `publishMode` is `auto` or `approval`; see [approval rules](#approval-rules).

Edit them in the format editor (**Series → Format**); the series page's **Cadence** card shows the
summary, the lead time, the publish mode and the next five slots. Several series may share a
format, and so its cadence.

### What the planner does

`cadence.plan` (`apps/api/src/modules/cadence/plan.ts`) looks at the next `CADENCE_HORIZON_DAYS`
(14 by default) of an active series in an active project, for slots on the channels the series
publishes to (linked, switched on, and not disabled). For each slot it makes sure there is:

1. **An item**: an idea titled `<series> · <local date>` (with the local time too when the cadence
   has several times a day), created by the system with the slot as its target. Its topic is the
   least recently used one from the format's topic pool, skipping the avoid list and the last three
   topics used.
2. **A planned post** on each channel, at the slot. Its `dryRun` flag is fixed now (see
   [dry-run](#dry-run-and-going-live)).
3. **A `cadence.produce` task** at `leadTimeHours` before the slot, or at once when the lead time
   has already begun.
4. **A `post.publish` task** at the slot.

The planner never plans a slot less than two minutes away (`MIN_SCHEDULE_LEAD_MS`). Running it
again changes nothing: it serialises on the series row, and an item already holding a slot keeps
it. It also follows changes:

- **A slot that disappears** (the series is paused or archived, the cadence changed, or its last
  channel was switched off) gives up its idea: the idea's open posts are cancelled and it is
  archived. Only ideas the planner made, with no production job running, are touched; anything
  further along keeps its posts.
- **A channel switched off for the series** loses its planned, never-attempted posts on ideas that
  keep their slot. Switching it on again plans them again.
- **A cancelled post** is never planned again: cancelling is a person's decision.
- **A changed lead time** moves the pending production tasks to match.

The calendar shows every post and the open slots (slots no post holds). An open slot can take an
approved video (**Calendar → open slot → Schedule**), which creates a `queued` post. Producer
sessions see the same slots with the `calendar.get_slots` MCP tool.

### Post states

| State | Meaning |
|---|---|
| `planned` | Holds a slot; its item is not approved yet, so it has no version |
| `queued` | The item is approved; the post waits for its time with the approved version |
| `publishing` | Being sent, or waiting for the platform to finish processing |
| `published` | Live, or recorded in dry-run, with a permalink |
| `failed` | The publisher gave up; `lastError` says why |
| `cancelled` | Withdrawn by a person or by replanning |
| `missed` | Its time came while it was still `planned` |

Planned, queued, failed and missed posts can be moved: drag them on the calendar (or pick them up
with Space and move them with the arrow keys), or use **Reschedule** for missed posts in the
approvals inbox. A move needs a time at least two minutes ahead and the post's latest
`updatedAt` (a stale one is `409 conflict`, and the calendar reloads the post). A moved post is
`queued` when its item is approved and `planned` otherwise, and the item's production task moves
with its earliest post. Publishing, published and cancelled posts stay put.

## Approval rules

Each post publishes in the effective mode of its series' format and its channel
(`effectivePublishMode`):

| Format `publishMode` | Channel requires approval | Post |
|---|---|---|
| `auto` | no | `auto` |
| `auto` | yes | `approval` |
| `approval` | either | `approval` |

The rules (`apps/api/src/modules/approvals/rules.ts`) tie an item's state to its posts. They run
after each state change commits:

- **Entering review.** When the item has at least one planned post and every planned post is
  `auto`, and its version has a render, the system approves it: a review with the `system` actor.
  Otherwise it waits for a person in **Review** and in the **Approvals** inbox.
- **Approved** (by a person, by the system, or after a caption edit of an approved item). Planned
  posts become `queued` with the approved version, queued posts follow a newer approved version,
  each gets its publish task, and the item moves to `scheduled`.
- **Back into production** (an approved or scheduled item gets a new script, storyboard or voice,
  or a person unschedules it). Its queued posts return to `planned` and lose their version, so an
  unapproved version is never published.
- **Archived.** Its open posts are cancelled.

The publisher checks again at the slot: a post publishes only if its item is approved, scheduled
or published and the post's version is the item's current version. Otherwise the post fails with
"approve and schedule it again".

**The approvals inbox** (**Approvals**, `GET /api/approvals`) lists items in review with the
time left before their first slot, nearest first, with Approve and Request changes on each row.
Below it are **missed posts**: posts whose time came while still planned. Approve the video and
reschedule the post, or leave it.

## Dry-run and going live

Nothing reaches a platform unless three switches allow it. A post is sent live only when all of
these hold at its time:

| Switch | Where | Default |
|---|---|---|
| `PUBLISHING_MODE` | Server environment: `dry-run` or `live` | `dry-run` |
| The channel's **Dry run** switch | **Settings → Channels** | On for every new channel |
| The post's `dryRun` flag | Fixed when the post is created: on if the channel or the server was in dry-run | — |

So a post planned while its channel was in dry-run stays a dry run even after the channel goes
live, and switching a channel back to dry-run holds back posts already queued on it.

A channel's **Dry run** switch can only be turned off (`PATCH /api/channels/:id`) when nothing
blocks it; otherwise the API answers `409 dry_run_locked` with the blocker in `details.reason`:

| Blocker | Meaning |
|---|---|
| `platform_unavailable` | The platform has no live publishing on this server: X while `FEATURE_X_PUBLISHING` is off or its client is not set |
| `not_connected` | A planning channel: no account is connected |
| `not_active` | The channel needs reconnecting, or is disabled |
| `publishing_dry_run` | The server runs with `PUBLISHING_MODE=dry-run` |

`PUBLISHING_ENABLED=false` pauses publishing in either mode: posts that come due wait and try
again every 15 minutes. The channel settings and **Settings → Scheduler** show a banner while the
server dry-runs or is paused.

### What a dry run records

The dry-run adapter (`apps/api/src/modules/publisher/adapters/dry-run.ts`) stands in for every
platform. It validates the post with the platform's own checks (video length, size and aspect,
caption limits), builds the requests the live adapter would send with the same builders, and
records them on the post's publish attempt. It never reads credentials, never copies media to the
public bucket and never opens a connection:

- the post becomes `published` with the permalink `dryrun://<platform>/<postId>`;
- the attempt (`GET /api/scheduled-posts/:id/attempts`) holds the request plan (each step's
  method, API, path and body, such as Instagram's `create_container` with the caption and the
  video URL), with credentials replaced by `[redacted]` and media URLs on
  `https://dry-run.invalid/p/<postId>/…`, a domain that never resolves; and the response
  `{dryRun: true, permalink}`;
- the item moves to `published` on its first published post, like a live one.

Dry-run posts never count against the platforms' daily limits and are left out of analytics.

### Live publishing

The live adapters (Instagram Reels, Facebook Page Reels and Threads; X behind
`FEATURE_X_PUBLISHING`) need real accounts. To publish live:

1. Set `LOOMCAST_ENCRYPTION_KEY` (channel credentials are stored encrypted) and the platform app
   settings in `.env` (`META_*`, `THREADS_*`, `X_*`). The [Meta app runbook](runbooks/meta-app-setup.md)
   walks through creating the apps.
2. Connect the account: **Settings → Channels → Connect**, sign in with the platform and pick the
   accounts to add on the connect page. One Meta sign-in connects Facebook Pages and the Instagram
   professional accounts linked to them; Threads and X have their own sign-ins.
3. Run the server with `PUBLISHING_MODE=live`.
4. Turn the channel's **Dry run** switch off and type `publish live` to confirm.

Live posts pass two rate checks before anything is sent. A rolling 24-hour gate per channel
(Instagram 50, Facebook 30, Threads 250, X 17) counts its live attempts; and the platform's own
usage reports, stored on the channel after each live call, hold its calls back while any usage
is above 80% or after the platform refused one as rate limited. Either way the post stays
`queued` with a `rate_limited` note in `lastError` and tries again when the window allows. A
platform that accepts a video and processes it later leaves the post `publishing` while
`post.check_status` polls. Once a post is live, its insights are pulled on a decaying schedule for
analytics.

Channels whose credentials the platform refuses turn `needs_reauth`; the channel settings show a
**Reconnect** banner, and their posts fail with an `auth` error until the account is connected
again. **Disconnect** removes a channel's credentials and switches it back to dry-run; its series
links and posts stay, and its open posts only dry-run until it is connected again.

## Failures and dead letters

Every scheduled task has a retry policy in `scheduledTaskRegistry`
(`packages/contracts/src/scheduler/tasks.ts`): a number of attempts (3 to 5) and an exponential
backoff with jitter, capped at an hour. A handler may also ask to run again later (publishing
paused, a rate limit, status polling) without using an attempt. Tasks are claimed with
`FOR UPDATE SKIP LOCKED` under a lease, so a crashed or stopped server's task is picked up again
when its lease runs out.

- A failure that a retry cannot fix ends the task as **failed** at once, such as production that
  refuses because the format has no voice (`voice_not_configured`).
- A task whose every attempt failed is **dead**: it is audited (`scheduler.task.dead`), published
  as a `task.dead` event and raised as an alert.

**Settings → Scheduler** (owner and admins) shows the scheduler's last run and lists dead and failed
tasks with their last error and a **Retry** button, which runs the task again now with a fresh set
of attempts (`GET /api/scheduler/tasks?status=dead`, `POST /api/scheduler/tasks/:id/retry`). Fix
the cause first.

A post the publisher cannot send is handled on the post rather than the task. A transient error
(a timeout, a platform 5xx, a rate limit) puts the post back to `queued` and retries the task. A
permanent one (invalid media, refused credentials, an unapproved version) marks the post
`failed` with the error in `lastError`, audits `post.failed` and raises an alert, and the task
ends. Fix the cause, then drag the failed post to a new time to queue it again.

## Time zones

- **Cadences are local.** A slot is a wall-clock time in the cadence's `tz`, so `09:00` stays
  `09:00` there across daylight saving changes. A time the clocks skip moves forward to the first
  valid minute after the change; a time that happens twice uses the earlier instant
  (`generateSlots` in `packages/contracts/src/calendar/slots.ts`). The API, the scheduler and the
  web app all use these helpers, so they agree on every slot.
- **Instants are UTC.** Posts, tasks and the API store and return UTC timestamps. Item titles use
  the slot's date in the cadence's zone.
- **The calendar** shows the browser's time zone by default. When the shown series share one
  zone, **Series time** in the toolbar switches the grid to it. The week grid has half-hour rows
  from 06:00, with a lane above them for earlier posts. Dropping a post on a week cell keeps its
  minutes within the half hour (09:15 dropped on the 11:00 row lands at 11:15); dropping it on a
  month day keeps its time of day, in the zone the calendar shows.
- **The format editor and the series page** list the next slots in the cadence's zone and, when
  it differs, in yours.
- Analytics count posts by the UTC day they were published.

## Checking it

`pnpm test:e2e` runs this flow with the fake studio agent and dry-run channels
(`tests/e2e/specs/calendar.spec.ts`). The API runs its scheduler every 500 ms there. A series whose
format publishes automatically, every day at a local time a few minutes ahead in
`Asia/Colombo` with a one-hour lead time, is linked to a planning Instagram channel from its
series page and fills the calendar 14 days ahead. The first slot is produced at once and approved
by the system. A second series on the same format publishes to a Threads channel that requires
approval: its video waits in the approvals inbox until it is approved there. A planned post is
dragged to the next day on the month view. At the slot both posts publish in dry-run with their
`dryrun://` permalinks and recorded requests, and no task is dead. The
[M4 acceptance runbook](local-development.md#m4-acceptance-runbook) is the same flow by hand.
