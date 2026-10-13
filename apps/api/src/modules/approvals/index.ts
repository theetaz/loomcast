import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";
import { createWorkTracker, type WorkTracker } from "../cadence/work";
import { contentServiceFor } from "../content";
import { serviceFor } from "../content/support";
import { reviewsServiceFor } from "../reviews";
import { type ApprovalRules, createApprovalRules } from "./rules";

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
 * Approval rules: every committed item state change runs them (auto-approval on entering review,
 * queueing posts on approval, taking them back when the item leaves approval).
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

  app.route("/", router);
  return router;
}
