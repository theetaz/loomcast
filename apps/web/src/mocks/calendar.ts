import {
  type ApiError,
  CalendarQuerySchema,
  type CalendarSlot,
  type Channel,
  type ContentItem,
  type Format,
  generateSlots,
  type Platform,
  routes,
  type ScheduledPost,
  type Series,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { z } from "zod";
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
