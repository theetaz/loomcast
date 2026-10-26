import {
  type ApiError,
  type ContentItem,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  ReviewQueueQuerySchema,
  routes,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { MockDb } from "./db";

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

/** The API's queue order: `targetAt` (nulls last), then `updatedAt`, oldest first. */
export function queueOrder(a: ContentItem, b: ContentItem): number {
  if (a.targetAt && b.targetAt && a.targetAt !== b.targetAt) {
    return a.targetAt.localeCompare(b.targetAt);
  }
  if (a.targetAt && !b.targetAt) return -1;
  if (!a.targetAt && b.targetAt) return 1;
  return a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
}

/** `GET /api/reviews/queue`: items in review; the cursor is the offset of the next page. */
export function createReviewQueueHandlers(db: MockDb) {
  return [
    http.get(path("reviews.queue"), ({ request }) => {
      if (!db.signedIn) return apiError(401, "unauthorized", "Sign in to continue.");
      const url = new URL(request.url);
      const parsed = ReviewQueueQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return apiError(400, "validation_failed", "The request is not valid.");
      const query = parsed.data;
      const all = db.contentItems
        .filter(
          (item) =>
            item.state === "review" &&
            (!query.workspaceId || item.workspaceId === query.workspaceId),
        )
        .sort(queueOrder);
      const offset = Number(query.cursor ?? 0) || 0;
      const limit = Math.min(MAX_PAGE_LIMIT, query.limit ?? DEFAULT_PAGE_LIMIT);
      const items = all.slice(offset, offset + limit).map((item) => ({ ...item }));
      const next = offset + limit;
      return HttpResponse.json({ items, nextCursor: next < all.length ? String(next) : null });
    }),
  ];
}
