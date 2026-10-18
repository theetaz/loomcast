import {
  type ApiError,
  type ApprovalItem,
  ApprovalsQuerySchema,
  routes,
  type ScheduledPost,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { MockDb } from "./db";

// `GET /api/approvals`, following the approvals module of the API: items in review with their
// open posts and the earliest of their times, and the missed posts.

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

/** Most items in review the inbox lists, as in the API. */
const MAX_ITEMS = 200;
/** Most missed posts the inbox lists, as in the API. */
const MAX_MISSED = 100;

/** A post as the API joins it: with its item's current title, state, format and poster. */
function joined(db: MockDb, post: ScheduledPost): ScheduledPost {
  const item = db.contentItems.find((entry) => entry.id === post.itemId);
  return item
    ? {
        ...post,
        item: {
          title: item.title,
          state: item.state,
          format: item.format,
          posterAssetId: item.posterAssetId,
        },
      }
    : { ...post };
}

export function createApprovalHandlers(db: MockDb) {
  return [
    http.get(path("approvals.inbox"), ({ request }) => {
      if (!db.signedIn) return apiError(401, "unauthorized", "Sign in to continue.");
      const url = new URL(request.url);
      const parsed = ApprovalsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return apiError(400, "validation_failed", "The request is not valid.");
      const { projectId } = parsed.data;
      const byTime = (a: ScheduledPost, b: ScheduledPost) =>
        a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id);

      const items: ApprovalItem[] = db.contentItems
        .filter((item) => item.state === "review" && (!projectId || item.projectId === projectId))
        .map((item) => {
          const posts = db.posts
            .filter(
              (post) =>
                post.itemId === item.id && (post.status === "planned" || post.status === "queued"),
            )
            .sort(byTime)
            .map((post) => joined(db, post));
          return { item: { ...item }, deadlineAt: posts[0]?.scheduledAt ?? null, posts };
        })
        .sort((a, b) => {
          if (a.deadlineAt !== b.deadlineAt) {
            if (a.deadlineAt === null) return 1;
            if (b.deadlineAt === null) return -1;
            return a.deadlineAt.localeCompare(b.deadlineAt);
          }
          return (
            a.item.updatedAt.localeCompare(b.item.updatedAt) || a.item.id.localeCompare(b.item.id)
          );
        })
        .slice(0, MAX_ITEMS);

      const missed = db.posts
        .filter((post) => post.status === "missed" && (!projectId || post.projectId === projectId))
        .sort((a, b) => byTime(b, a))
        .slice(0, MAX_MISSED)
        .map((post) => joined(db, post));

      return HttpResponse.json({ items, missed });
    }),
  ];
}
