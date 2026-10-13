import type { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";
import { flagNeedsReauth } from "../channels/reauth";
import { registerInsightsTasks } from "./tasks";

export {
  countOf,
  FACEBOOK_REELS_INSIGHTS_METRICS,
  INSIGHTS_PLATFORMS,
  INSTAGRAM_INSIGHTS_METRICS,
  type InsightsCall,
  type InsightsPlatform,
  insightsRequest,
  metricValues,
  type NormalizedInsights,
  normalizeInsights,
  stripCredentials,
  supportsInsights,
  THREADS_INSIGHTS_METRICS,
} from "./normalize";
export { enqueueInsightsPulls, insightsDedupeKey } from "./schedule";
export { type InsightsDeps, registerInsightsTasks } from "./tasks";

/**
 * Insights: the `insights.pull` task handler. The publisher enqueues a post's pulls on the
 * `insightsSchedule` when it goes live (`enqueueInsightsPulls`); each run stores a capture in
 * `post_metrics`. A channel whose credentials the platform refuses turns `needs_reauth`.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const logger = deps.logger.child({ module: "insights" });
  registerInsightsTasks({
    db: deps.db,
    bus: deps.bus,
    logger,
    scheduler: deps.scheduler,
    vault: deps.vault,
    platforms: deps.config.platforms,
    onCredentialsRefused: async ({ channelId, error }) => {
      await flagNeedsReauth(deps, logger, { channelId, error, reason: "insights_refused" });
    },
  });
  return app;
}
