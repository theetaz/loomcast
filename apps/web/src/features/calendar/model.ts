import {
  type CalendarResponse,
  type CalendarSlot,
  RESCHEDULABLE_POST_STATUSES,
  type ScheduledPost,
} from "@loomcast/contracts";

// Pure cache updates for `calendar.get` responses. The query cache holds one response per range
// and filter; moves, live events and new posts go through these functions so every view agrees.

/** What one calendar query asks for. Ids are sorted so equal filters share a cache entry. */
export interface CalendarQueryKey {
  /** The workspace the calendar shows; every workspace when left out. */
  workspaceId?: string;
  from: string;
  to: string;
  channelIds: string[];
  seriesIds: string[];
}

export function isReschedulable(post: Pick<ScheduledPost, "status">): boolean {
  return (RESCHEDULABLE_POST_STATUSES as readonly string[]).includes(post.status);
}

/** Posts the calendar draws: everything but cancelled posts. */
export function isVisiblePost(post: Pick<ScheduledPost, "status">): boolean {
  return post.status !== "cancelled";
}

function sameInstant(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b);
}

/**
 * Points every slot at the post that holds it: a visible post of the same series and channel at
 * the same instant. A slot whose post moved away is open again.
 */
export function linkSlots(posts: readonly ScheduledPost[], slots: readonly CalendarSlot[]) {
  return slots.map((slot) => {
    const holder = posts.find(
      (post) =>
        isVisiblePost(post) &&
        post.seriesId === slot.seriesId &&
        post.channelId === slot.channelId &&
        sameInstant(post.scheduledAt, slot.at),
    );
    if (holder?.id === slot.postId) return slot;
    const { postId: _previous, ...open } = slot;
    return holder ? { ...open, postId: holder.id } : open;
  });
}

function byTime(a: ScheduledPost, b: ScheduledPost): number {
  return Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt) || a.id.localeCompare(b.id);
}

function withPosts(data: CalendarResponse, posts: ScheduledPost[]): CalendarResponse {
  posts.sort(byTime);
  return { posts, slots: linkSlots(posts, data.slots) };
}

/** Moves a post to `scheduledAt` (the optimistic half of a reschedule). */
export function movePost(
  data: CalendarResponse,
  postId: string,
  scheduledAt: string,
): CalendarResponse {
  if (!data.posts.some((post) => post.id === postId)) return data;
  return withPosts(
    data,
    data.posts.map((post) => (post.id === postId ? { ...post, scheduledAt } : post)),
  );
}

/** A reschedule in flight: the post as it was and the time it was moved to. */
export interface PendingMove {
  previous: ScheduledPost;
  scheduledAt: string;
}

/**
 * Undoes an optimistic move. The post goes back only while it is still the optimistic copy: if a
 * live event replaced it meanwhile, the newer copy stays.
 */
export function rollbackMove(data: CalendarResponse, move: PendingMove): CalendarResponse {
  const current = data.posts.find((post) => post.id === move.previous.id);
  if (
    !current ||
    current.updatedAt !== move.previous.updatedAt ||
    !sameInstant(current.scheduledAt, move.scheduledAt)
  ) {
    return data;
  }
  return withPosts(
    data,
    data.posts.map((post) => (post.id === move.previous.id ? move.previous : post)),
  );
}

/** Whether `post` belongs in the response for `key`. */
export function postMatches(post: ScheduledPost, key: CalendarQueryKey): boolean {
  const at = Date.parse(post.scheduledAt);
  if (at < Date.parse(key.from) || at >= Date.parse(key.to)) return false;
  if (key.workspaceId && post.workspaceId !== key.workspaceId) return false;
  if (key.channelIds.length > 0 && !key.channelIds.includes(post.channelId)) return false;
  if (key.seriesIds.length > 0 && (!post.seriesId || !key.seriesIds.includes(post.seriesId))) {
    return false;
  }
  return true;
}

/**
 * Applies a created or changed post: replaced where it is, dropped when it left the range or the
 * filter, added when it arrived. A copy older than the cached one is ignored.
 */
export function upsertPost(
  data: CalendarResponse,
  post: ScheduledPost,
  key: CalendarQueryKey,
): CalendarResponse {
  const cached = data.posts.find((entry) => entry.id === post.id);
  if (cached && cached.updatedAt > post.updatedAt) return data;
  const others = data.posts.filter((entry) => entry.id !== post.id);
  if (!postMatches(post, key)) return cached ? withPosts(data, others) : data;
  return withPosts(data, [...others, post]);
}

/** The cached copy of a post, from any loaded range. */
export function findPost(
  responses: readonly (CalendarResponse | undefined)[],
  postId: string,
): ScheduledPost | undefined {
  for (const data of responses) {
    const post = data?.posts.find((entry) => entry.id === postId);
    if (post) return post;
  }
  return undefined;
}
