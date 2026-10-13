import { ApprovalsQuerySchema, routes } from "@loomcast/contracts";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { validationFailed } from "../../lib/errors";
import { issueDetails } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { createWorkTracker, type WorkTracker } from "../cadence/work";
import { contentServiceFor } from "../content";
import { serviceFor } from "../content/support";
import { reviewsServiceFor } from "../reviews";
import { approvalsInbox } from "./inbox";
import { type ApprovalRules, createApprovalRules } from "./rules";

export { APPROVALS_MAX_ITEMS, APPROVALS_MAX_MISSED, approvalsInbox } from "./inbox";
export {
  type ApprovalRules,
  type ApprovalRulesDeps,
  createApprovalRules,
  hasQueuedPost,
} from "./rules";

export interface ApprovalsRuntime {
  rules: ApprovalRules;
  /** Rule runs started by `content.item.state_changed`. */
  work: WorkTracker;
}

/** The app's approval rules (one per deps object), shared with the calendar endpoints. */
export function approvalsFor(deps: ModuleDeps): ApprovalsRuntime {
  return serviceFor(deps, "approvals", () => ({
    rules: createApprovalRules({
      db: deps.db,
      bus: deps.bus,
      scheduler: deps.scheduler,
      content: contentServiceFor(deps),
      reviews: reviewsServiceFor(deps),
    }),
    work: createWorkTracker(deps.logger.child({ module: "approvals" })),
  }));
}

/**
 * Approval rules and the approvals inbox. Every committed item state change runs the rules
 * (auto-approval on entering review, queueing posts on approval, taking them back when the item
 * leaves approval). `GET /api/approvals` lists items waiting for a decision with their nearest
 * slot, and missed posts.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { rules, work } = approvalsFor(deps);

  const unsubscribe = deps.bus.subscribe("content.item.state_changed", (event) => {
    work.run("approvals.rules", () => rules.onStateChanged(event.payload));
  });
  deps.lifecycle.onClose(async () => {
    unsubscribe();
    await work.idle();
  });

  router.get(routes["approvals.inbox"].path, async (c) => {
    currentUser(c);
    const parsed = ApprovalsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw validationFailed(issueDetails(parsed.error));
    }
    c.header("Cache-Control", "no-store");
    return c.json(await approvalsInbox(deps.db, parsed.data), 200);
  });

  app.route("/", router);
  return router;
}
