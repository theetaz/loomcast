import {
  type ApprovalItem,
  type ApprovalsInbox,
  OPEN_POST_STATUSES,
  type ScheduledPost,
} from "@loomcast/contracts";
import { contentItems, scheduledPosts } from "@loomcast/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../../lib/db";
import { byScheduledAt, loadScheduledPosts } from "../calendar/posts";
import { toContentItem } from "../content";
import { selectItems } from "../content/queries";

/** Most items in review the inbox lists. */
export const APPROVALS_MAX_ITEMS = 200;

/** Most missed posts the inbox lists. */
export const APPROVALS_MAX_MISSED = 100;

/**
 * Items in review with their open posts and the nearest of their times (`deadlineAt`), soonest
 * deadline first, items without one last, then the longest waiting; and the missed posts, most
 * recent first.
 */
export async function approvalsInbox(
  executor: Executor,
  filter: { projectId?: string },
): Promise<ApprovalsInbox> {
  const inProject = (column: typeof contentItems.projectId) =>
    filter.projectId === undefined ? undefined : eq(column, filter.projectId);

  const rows = await selectItems(executor)
    .where(and(eq(contentItems.state, "review"), inProject(contentItems.projectId)))
    .orderBy(asc(contentItems.updatedAt), asc(contentItems.id));
  const itemIds = rows.map((row) => row.id);
  const openIds =
    itemIds.length === 0
      ? []
      : await executor
          .select({ id: scheduledPosts.id })
          .from(scheduledPosts)
          .where(
            and(
              inArray(scheduledPosts.itemId, itemIds),
              inArray(scheduledPosts.status, [...OPEN_POST_STATUSES]),
            ),
          );
  const postsByItem = new Map<string, ScheduledPost[]>();
  for (const post of (
    await loadScheduledPosts(
      executor,
      openIds.map((row) => row.id),
    )
  ).sort(byScheduledAt)) {
    const list = postsByItem.get(post.itemId) ?? [];
    list.push(post);
    postsByItem.set(post.itemId, list);
  }
  const items: ApprovalItem[] = rows.map((row) => {
    const posts = postsByItem.get(row.id) ?? [];
    return { item: toContentItem(row), deadlineAt: posts[0]?.scheduledAt ?? null, posts };
  });
  items.sort((a, b) => {
    if (a.deadlineAt !== b.deadlineAt) {
      if (a.deadlineAt === null) return 1;
      if (b.deadlineAt === null) return -1;
      return a.deadlineAt.localeCompare(b.deadlineAt);
    }
    return a.item.updatedAt.localeCompare(b.item.updatedAt) || a.item.id.localeCompare(b.item.id);
  });

  const missedIds = await executor
    .select({ id: scheduledPosts.id })
    .from(scheduledPosts)
    .innerJoin(contentItems, eq(contentItems.id, scheduledPosts.itemId))
    .where(and(eq(scheduledPosts.status, "missed"), inProject(contentItems.projectId)))
    .orderBy(desc(scheduledPosts.scheduledAt), desc(scheduledPosts.id))
    .limit(APPROVALS_MAX_MISSED);
  const missed = (
    await loadScheduledPosts(
      executor,
      missedIds.map((row) => row.id),
    )
  ).sort((a, b) => byScheduledAt(b, a));

  return { items: items.slice(0, APPROVALS_MAX_ITEMS), missed };
}
