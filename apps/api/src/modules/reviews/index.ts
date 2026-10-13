import { CreateReviewRequestSchema, ReviewQueueQuerySchema, routes } from "@loomcast/contracts";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound, validationFailed } from "../../lib/errors";
import { idParam, issueDetails, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { userActor } from "../content/actor";
import { serviceFor } from "../content/support";
import { createReviewsService, type ReviewsService, type ReviewsServiceDeps } from "./service";

export {
  createReviewsService,
  type ReviewOptions,
  type ReviewsService,
  type ReviewsServiceDeps,
  toReview,
} from "./service";

/** The app's reviews service (one per deps object); the calendar uses it for auto-approval. */
export function reviewsServiceFor(deps: ReviewsServiceDeps): ReviewsService {
  return serviceFor(deps, "reviews", () => createReviewsService(deps));
}

const itemNotFound = () => notFound("No content item has that id.");

/**
 * Review endpoints: decide an item in review (approve, request changes, reject), list an item's
 * reviews, and the review queue. Decisions move the item through the content service's
 * transitions and publish `review.created`.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const service = reviewsServiceFor(deps);
  const router = new Hono<AppEnv>();
  const trustProxy = deps.config.trustProxy;

  router.get(routes["reviews.queue"].path, async (c) => {
    currentUser(c);
    const query = ReviewQueueQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      throw validationFailed(issueDetails(query.error));
    }
    const page = await service.queue(query.data);
    if (page === null) {
      throw notFound("Project not found.");
    }
    return c.json(page, 200);
  });

  router.post(routes["reviews.create"].path, async (c) => {
    const id = idParam(c);
    const input = await readJson(c, CreateReviewRequestSchema);
    const result = await service.create(id, input, userActor(c, trustProxy));
    if (result === null) {
      throw itemNotFound();
    }
    return c.json(result, 201);
  });

  router.get(routes["reviews.list"].path, async (c) => {
    currentUser(c);
    const items = await service.list(idParam(c));
    if (items === null) {
      throw itemNotFound();
    }
    return c.json({ items }, 200);
  });

  app.route("/", router);
  return router;
}
