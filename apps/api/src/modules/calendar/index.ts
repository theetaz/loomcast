import {
  CalendarQuerySchema,
  CreatePostRequestSchema,
  ReschedulePostRequestSchema,
  routes,
} from "@loomcast/contracts";
import { type Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { validationFailed } from "../../lib/errors";
import { idParam, issueDetails, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { contentServiceFor, userActor } from "../content";
import { serviceFor } from "../content/support";
import { type CalendarService, createCalendarService } from "./service";

export {
  APPROVED_ITEM_STATES,
  byScheduledAt,
  enqueuePublish,
  loadScheduledPosts,
  newPostDryRun,
  publishPostsUpdated,
  publishTaskKey,
  toScheduledPost,
} from "./posts";
export { type CalendarService, type CalendarServiceDeps, createCalendarService } from "./service";
export {
  cadenceSlots,
  listSlots,
  loadSeriesPlans,
  type PlanChannel,
  type SeriesPlan,
  type SlotQuery,
} from "./slots";

/** The app's calendar service (one per deps object). */
export function calendarServiceFor(deps: ModuleDeps): CalendarService {
  return serviceFor(deps, "calendar", () =>
    createCalendarService({
      db: deps.db,
      bus: deps.bus,
      clock: deps.clock,
      scheduler: deps.scheduler,
      content: contentServiceFor(deps),
      config: deps.config,
    }),
  );
}

/** The query string with list parameters that may repeat kept as arrays. */
function calendarQuery(c: Context<AppEnv>): Record<string, unknown> {
  const query: Record<string, unknown> = { ...c.req.query() };
  for (const key of ["seriesIds", "channelIds"]) {
    const values = c.req.queries(key);
    if (values !== undefined && values.length > 1) {
      query[key] = values;
    }
  }
  return query;
}

/**
 * Calendar endpoints: `GET /api/calendar` (posts and open cadence slots in a range of at most 62
 * days), and scheduling, rescheduling and cancelling posts. Every change publishes `post.updated`.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const calendar = calendarServiceFor(deps);
  const trustProxy = deps.config.trustProxy;

  router.get(routes["calendar.get"].path, async (c) => {
    currentUser(c);
    const parsed = CalendarQuerySchema.safeParse(calendarQuery(c));
    if (!parsed.success) {
      throw validationFailed(issueDetails(parsed.error));
    }
    c.header("Cache-Control", "no-store");
    return c.json(await calendar.get(parsed.data), 200);
  });

  router.post(routes["scheduledPosts.create"].path, async (c) => {
    const input = await readJson(c, CreatePostRequestSchema);
    const post = await calendar.create(input, userActor(c, trustProxy));
    return c.json(post, 201);
  });

  router.patch(routes["scheduledPosts.reschedule"].path, async (c) => {
    const id = idParam(c);
    const input = await readJson(c, ReschedulePostRequestSchema);
    const post = await calendar.reschedule(id, input, userActor(c, trustProxy));
    return c.json(post, 200);
  });

  router.post(routes["scheduledPosts.cancel"].path, async (c) => {
    const id = idParam(c);
    const post = await calendar.cancel(id, userActor(c, trustProxy));
    return c.json(post, 200);
  });

  app.route("/", router);
  return router;
}
