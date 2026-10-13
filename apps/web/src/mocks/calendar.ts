import {
  type ApiError,
  CalendarQuerySchema,
  type CalendarSlot,
  type Channel,
  type ContentItem,
  CreatePostRequestSchema,
  effectivePublishMode,
  type Format,
  generateSlots,
  MIN_SCHEDULE_LEAD_MS,
  type Platform,
  RESCHEDULABLE_POST_STATUSES,
  ReschedulePostRequestSchema,
  routes,
  type ScheduledPost,
  type Series,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { z } from "zod";
import { updateContentItem } from "./content";
import { type MockDb, mockId, publish } from "./db";

// Channels, cadence slots and scheduled posts, following `@loomcast/contracts`. The
// scheduler and the calendar API come later; this mock answers the calendar's routes the way the
// contracts describe them, so the web app can be built and tested against it. Formats and their
// cadences come from `./formats`.

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");
const postNotFound = () => apiError(404, "not_found", "No scheduled post has that id.");

function invalid(error: z.ZodError) {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return apiError(400, "validation_failed", `${where}${issue?.message ?? "Check the request."}`);
}

/** A timestamp after `previous`, so two quick writes never share an `updatedAt`. */
function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

// Builders ----------------------------------------------------------------------

export function mockChannel(
  overrides: Partial<Channel> & Pick<Channel, "platform" | "displayName">,
): Channel {
  const at = overrides.createdAt ?? new Date().toISOString();
  return {
    id: mockId(),
    externalId: null,
    username: null,
    parentChannelId: null,
    status: "disconnected",
    dryRun: true,
    requiresApproval: false,
    connected: false,
    scopes: [],
    tokenExpiresAt: null,
    liveBlocker: "not_connected",
    createdAt: at,
    updatedAt: at,
    disabledAt: null,
    ...overrides,
  };
}

/** A post of `item` on `channel` at `scheduledAt`; queued (with the current version) by default. */
export function mockPost(
  overrides: Partial<ScheduledPost> & {
    item: ContentItem;
    channel: Channel;
    scheduledAt: string;
  },
): ScheduledPost {
  const { item, channel, ...post } = overrides;
  const at = post.createdAt ?? new Date().toISOString();
  const status = post.status ?? "queued";
  const id = post.id ?? mockId();
  return {
    id,
    projectId: item.projectId,
    itemId: item.id,
    versionId: status === "planned" ? null : item.currentVersionId,
    channelId: channel.id,
    seriesId: item.seriesId,
    platform: channel.platform,
    status,
    dryRun: true,
    publishMode: "approval",
    externalId: status === "published" ? `dry-${id.slice(0, 8)}` : null,
    permalink: status === "published" ? `dryrun://${channel.platform}/${id}` : null,
    attempts: status === "published" || status === "failed" ? 1 : 0,
    lastError: null,
    publishedAt: status === "published" ? post.scheduledAt : null,
    createdAt: at,
    updatedAt: at,
    ...post,
    item: { title: item.title, state: item.state, posterAssetId: item.posterAssetId },
  };
}

// Queries -----------------------------------------------------------------------

function isOpen(post: ScheduledPost): boolean {
  return post.status === "planned" || post.status === "queued";
}

function cadenceOf(db: MockDb, series: Series): Format | undefined {
  return db.formats.find((format) => format.id === series.formatId);
}

/** Open and held cadence slots in `[from, to)` from now on, like `GET /api/calendar`. */
export function mockSlots(
  db: MockDb,
  range: { from: string; to: string },
  filter: { projectId?: string; channelIds?: string[]; seriesIds?: string[] } = {},
  now = Date.now(),
): CalendarSlot[] {
  const from = Math.max(Date.parse(range.from), now);
  const to = Date.parse(range.to);
  if (to <= from) return [];
  const slots: CalendarSlot[] = [];
  for (const series of db.series) {
    if (series.status !== "active") continue;
    if (filter.projectId && series.projectId !== filter.projectId) continue;
    if (filter.seriesIds && !filter.seriesIds.includes(series.id)) continue;
    const format = cadenceOf(db, series);
    const links = db.seriesChannels.find((entry) => entry.seriesId === series.id)?.channels ?? [];
    if (!format) continue;
    const times = generateSlots(format.currentVersion.rules.cadence, new Date(from), new Date(to));
    for (const link of links) {
      const channel = db.channels.find((entry) => entry.id === link.channelId);
      if (!link.enabled || !channel || channel.status === "disabled") continue;
      if (filter.channelIds && !filter.channelIds.includes(channel.id)) continue;
      for (const time of times) {
        const at = time.toISOString();
        const holder = db.posts.find(
          (post) =>
            post.status !== "cancelled" &&
            post.seriesId === series.id &&
            post.channelId === channel.id &&
            Date.parse(post.scheduledAt) === time.getTime(),
        );
        slots.push({
          at,
          seriesId: series.id,
          channelId: channel.id,
          ...(holder ? { postId: holder.id } : {}),
        });
      }
    }
  }
  return slots.sort((a, b) => a.at.localeCompare(b.at));
}

/** Changes a stored post, moves its `updatedAt` on and publishes `post.updated`. */
export function updatePost(
  db: MockDb,
  id: string,
  change: (post: ScheduledPost) => void,
): ScheduledPost | null {
  const post = db.posts.find((entry) => entry.id === id);
  if (!post) return null;
  change(post);
  post.updatedAt = nextTimestamp(post.updatedAt);
  publish(db, { type: "post.updated", payload: { post: { ...post } } });
  return post;
}

// Handlers ----------------------------------------------------------------------

/** Channels, the calendar and scheduled posts. Formats are served with the content item mocks. */
export function createCalendarHandlers(db: MockDb) {
  return [
    http.get(path("channels.list"), () =>
      db.signedIn ? HttpResponse.json({ items: db.channels }) : unauthorized(),
    ),

    http.get(path("calendar.get"), ({ request }) => {
      if (!db.signedIn) return unauthorized();
      const url = new URL(request.url);
      const parsed = CalendarQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return invalid(parsed.error);
      const { from, to, projectId, channelIds, seriesIds } = parsed.data;
      const posts = db.posts
        .filter((post) => {
          const at = Date.parse(post.scheduledAt);
          return (
            at >= Date.parse(from) &&
            at < Date.parse(to) &&
            (!projectId || post.projectId === projectId) &&
            (!channelIds || channelIds.includes(post.channelId)) &&
            (!seriesIds || (post.seriesId !== null && seriesIds.includes(post.seriesId)))
          );
        })
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
        .map((post) => ({ ...post }));
      const slots = mockSlots(db, { from, to }, { projectId, channelIds, seriesIds });
      return HttpResponse.json({ posts, slots });
    }),

    http.post(path("scheduledPosts.create"), async ({ request }) => {
      if (!db.signedIn) return unauthorized();
      const parsed = CreatePostRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      const { itemId, channelId, scheduledAt } = parsed.data;
      const item = db.contentItems.find((entry) => entry.id === itemId);
      if (!item) return apiError(404, "not_found", "No content item has that id.");
      const channel = db.channels.find((entry) => entry.id === channelId);
      if (!channel) return apiError(404, "not_found", "No channel has that id.");
      if (item.state !== "approved" && item.state !== "scheduled") {
        return apiError(409, "invalid_transition", "Only approved videos can be scheduled.");
      }
      if (channel.status === "disabled") {
        return apiError(409, "conflict", "The channel is disabled.");
      }
      if (Date.parse(scheduledAt) < Date.now() + MIN_SCHEDULE_LEAD_MS) {
        return apiError(
          400,
          "validation_failed",
          "scheduledAt: Pick a time at least two minutes ahead.",
        );
      }
      if (
        db.posts.some(
          (post) => post.itemId === itemId && post.channelId === channelId && isOpen(post),
        )
      ) {
        return apiError(409, "conflict", "This video already has an open post on that channel.");
      }
      const series = db.series.find((entry) => entry.id === item.seriesId);
      const format = series ? cadenceOf(db, series) : undefined;
      const post = mockPost({
        item,
        channel,
        scheduledAt: new Date(scheduledAt).toISOString(),
        status: "queued",
        publishMode: effectivePublishMode(
          format?.currentVersion.rules.publishMode ?? "approval",
          channel.requiresApproval,
        ),
      });
      db.posts.push(post);
      if (item.state === "approved") {
        const updated = updateContentItem(db, item.id, (entry) => {
          entry.state = "scheduled";
        });
        if (updated) post.item = { ...post.item, state: updated.state };
      }
      publish(db, { type: "post.updated", payload: { post: { ...post } } });
      return HttpResponse.json(post, { status: 201 });
    }),

    http.patch(path("scheduledPosts.reschedule"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const found = db.posts.find((post) => post.id === params.id);
      if (!found) return postNotFound();
      const parsed = ReschedulePostRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      const { scheduledAt, expectedUpdatedAt } = parsed.data;
      if (!(RESCHEDULABLE_POST_STATUSES as readonly string[]).includes(found.status)) {
        return apiError(
          409,
          "post_not_editable",
          "This post is publishing, published or cancelled.",
        );
      }
      if (Date.parse(expectedUpdatedAt) !== Date.parse(found.updatedAt)) {
        return apiError(409, "conflict", "The post changed since you loaded it.");
      }
      if (Date.parse(scheduledAt) < Date.now() + MIN_SCHEDULE_LEAD_MS) {
        return apiError(
          400,
          "validation_failed",
          "scheduledAt: Pick a time at least two minutes ahead.",
        );
      }
      const post = updatePost(db, found.id, (entry) => {
        entry.scheduledAt = new Date(scheduledAt).toISOString();
        // A failed or missed post waits for its new time again.
        if (entry.status === "failed" || entry.status === "missed") {
          entry.status = entry.versionId ? "queued" : "planned";
          entry.lastError = null;
        }
      });
      return HttpResponse.json(post);
    }),

    http.post(path("scheduledPosts.cancel"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const found = db.posts.find((post) => post.id === params.id);
      if (!found) return postNotFound();
      if (!(RESCHEDULABLE_POST_STATUSES as readonly string[]).includes(found.status)) {
        return apiError(
          409,
          "post_not_editable",
          "This post is publishing, published or cancelled.",
        );
      }
      const post = updatePost(db, found.id, (entry) => {
        entry.status = "cancelled";
      });
      return HttpResponse.json(post);
    }),
  ];
}

// Demo data -------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60_000;

/**
 * Mock mode: demo channels and posts over the demo content, after `seedFormatDemo` gave the series
 * their cadences. Each series' items hold its next slots, a few slots stay open, and past slots
 * carry published (and one missed) posts. Items get their slot as target.
 */
export function seedCalendarDemo(db: MockDb, now: number) {
  const created = new Date(now - 30 * DAY_MS).toISOString();
  const channel = (platform: Platform, displayName: string, username: string) =>
    mockChannel({ platform, displayName, username, createdAt: created });
  const facebook = channel("facebook", "Rust in 60 seconds", "rustin60");
  const instagram = channel("instagram", "@rustin60", "rustin60");
  const threads = channel("threads", "@rustin60", "rustin60");
  const agentsInstagram = channel("instagram", "@agents.smallteams", "agents.smallteams");
  db.channels.push(facebook, instagram, threads, agentsInstagram);

  const byTitle = (title: string) => db.contentItems.find((item) => item.title.startsWith(title));

  const plan = (
    seriesName: string,
    linked: Channel[],
    upcoming: [title: string, channels?: Channel[]][],
    past: [title: string, status: ScheduledPost["status"]][],
  ) => {
    const series = db.series.find((entry) => entry.name === seriesName);
    const cadence = series ? cadenceOf(db, series)?.currentVersion.rules.cadence : undefined;
    if (!series || !cadence) return;
    db.seriesChannels.push({
      seriesId: series.id,
      channels: linked.map((entry) => ({ channelId: entry.id, enabled: true })),
    });
    const next = generateSlots(cadence, new Date(now + 60 * 60_000), new Date(now + 28 * DAY_MS));
    const before = generateSlots(cadence, new Date(now - 21 * DAY_MS), new Date(now)).reverse();
    const place = (title: string, at: Date, status: ScheduledPost["status"], on: Channel[]) => {
      const item = byTitle(title);
      if (!item) return;
      item.targetAt = at.toISOString();
      for (const target of on) {
        db.posts.push(
          mockPost({
            item,
            channel: target,
            scheduledAt: at.toISOString(),
            status,
            createdAt: created,
          }),
        );
      }
    };
    upcoming.forEach(([title, on], index) => {
      const at = next[index];
      const item = byTitle(title);
      if (!at || !item) return;
      const status = item.state === "approved" || item.state === "scheduled" ? "queued" : "planned";
      if (status === "queued") item.state = "scheduled";
      place(title, at, status, on ?? linked);
    });
    past.forEach(([title, status], index) => {
      const at = before[index];
      if (at) place(title, at, status, linked);
    });
  };

  plan(
    "Ownership basics",
    [facebook, instagram, threads],
    [
      ["Slices without the confusion"],
      ["Moves explained with a coffee cup"],
      ["Lifetimes are just scopes with names"],
      ["Box, Rc and Arc on one screen"],
    ],
    [["String vs &str, finally", "published"]],
  );
  plan(
    "Error handling",
    [instagram, threads],
    [
      ["unwrap is a promise you make to the reader"],
      ["anyhow vs thiserror, picked in one rule"],
      // Only on Instagram: its Threads slot stays open for the slot picker.
      ["Result is just an enum", [instagram]],
      ["The question mark operator in 40 seconds"],
    ],
    [],
  );
  plan(
    "Agent patterns",
    [agentsInstagram],
    [["One agent, one job: the small-team rule"]],
    [
      ["Hand-offs that do not lose context", "missed"],
      ["What to log when an agent fails", "published"],
    ],
  );
}
