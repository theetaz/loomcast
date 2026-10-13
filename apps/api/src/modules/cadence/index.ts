import { series } from "@loomcast/db";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";
import { contentServiceFor } from "../content";
import { serviceFor } from "../content/support";
import { TaskFailure } from "../scheduler";
import { type PlannerDeps, type PlanResult, planSeries, planTaskKey, seriesToPlan } from "./plan";
import { produceForSlot } from "./produce";
import { createWorkTracker, type WorkTracker } from "./work";

export {
  type PlannerDeps,
  type PlanResult,
  plannedTitle,
  planSeries,
  planTaskKey,
  produceAt,
  produceTaskKey,
  RETIRE_REASON,
  seriesToPlan,
} from "./plan";
export { type ProduceOutcome, produceForSlot } from "./produce";
export { type PickTopicInput, pickTopic, RECENT_TOPIC_WINDOW, type TopicUse } from "./topics";
export { createWorkTracker, type WorkTracker } from "./work";

export interface CadenceService {
  /** Plans one series (null when it does not exist), or every series the hourly run visits. */
  plan(seriesId?: string): Promise<PlanResult[]>;
  /** Queues a replan of the series right away, under `plan:<seriesId>`. */
  replan(seriesId: string): Promise<void>;
  /** Resolves once replans queued by bus events have been enqueued. */
  idle(): Promise<void>;
}

interface CadenceRuntime extends CadenceService {
  /** Background work started by bus listeners. */
  work: WorkTracker;
}

/** The app's cadence service (one per deps object). */
export function cadenceServiceFor(deps: ModuleDeps): CadenceService {
  return cadenceRuntimeFor(deps);
}

function cadenceRuntimeFor(deps: ModuleDeps): CadenceRuntime {
  return serviceFor(deps, "cadence", () => createCadenceService(deps));
}

function createCadenceService(deps: ModuleDeps): CadenceRuntime {
  const logger = deps.logger.child({ module: "cadence" });
  const work: WorkTracker = createWorkTracker(logger);
  const planner: PlannerDeps = {
    db: deps.db,
    bus: deps.bus,
    logger,
    scheduler: deps.scheduler,
    content: contentServiceFor(deps),
    config: deps.config,
  };

  async function replan(seriesId: string): Promise<void> {
    await deps.scheduler.enqueue(
      "cadence.plan",
      { seriesId },
      { dedupeKey: planTaskKey(seriesId) },
    );
  }

  return {
    async plan(seriesId) {
      const now = deps.clock.now();
      if (seriesId !== undefined) {
        const result = await planSeries(planner, seriesId, now);
        return result === null ? [] : [result];
      }
      const results: PlanResult[] = [];
      for (const id of await seriesToPlan(deps.db, now)) {
        try {
          const result = await planSeries(planner, id, now);
          if (result !== null) results.push(result);
        } catch (error) {
          // One broken series must not hold up the others; the next hourly run tries again.
          logger.error({ err: error, seriesId: id }, "cadence planning failed for a series");
        }
      }
      return results;
    },
    replan,
    idle: () => work.idle(),
    work,
  };
}

/**
 * Cadence planning: the `cadence.plan` task (hourly for every series, and right after a series,
 * its format or its channels change) turns cadences into items and planned posts; the
 * `cadence.produce` task starts production of an item `leadTimeHours` before its slot.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const cadence = cadenceRuntimeFor(deps);

  deps.scheduler.register("cadence.plan", async ({ payload, logger }) => {
    const results = await cadence.plan(payload.seriesId);
    if (payload.seriesId !== undefined && results.length === 0) {
      logger.info({ seriesId: payload.seriesId }, "cadence.plan: the series is gone");
    }
    for (const result of results) {
      if (
        result.createdItems.length > 0 ||
        result.createdPosts.length > 0 ||
        result.retiredItems.length > 0 ||
        result.cancelledPosts.length > 0 ||
        result.removedPosts.length > 0
      ) {
        logger.info(
          {
            seriesId: result.seriesId,
            slots: result.slots,
            createdItems: result.createdItems.length,
            createdPosts: result.createdPosts.length,
            retiredItems: result.retiredItems.length,
            cancelledPosts: result.cancelledPosts.length,
            removedPosts: result.removedPosts.length,
          },
          "cadence planned",
        );
      }
    }
  });

  registerProduceTask(deps);

  // Replan a series as soon as it, or its format, changes.
  const unsubscribeSeries = deps.bus.subscribe("series.updated", (event) => {
    cadence.work.run("cadence.replan", () => cadence.replan(event.payload.seriesId));
  });
  const unsubscribeFormat = deps.bus.subscribe("format.updated", (event) => {
    cadence.work.run("cadence.replan", async () => {
      const rows = await deps.db
        .select({ id: series.id })
        .from(series)
        .where(eq(series.formatId, event.payload.formatId))
        .orderBy(asc(series.id));
      for (const row of rows) await cadence.replan(row.id);
    });
  });
  deps.lifecycle.onClose(async () => {
    unsubscribeSeries();
    unsubscribeFormat();
    await cadence.work.idle();
  });

  app.route("/", router);
  return router;
}

/** `cadence.produce`: production up to review, for an item that still holds a slot. */
function registerProduceTask(deps: ModuleDeps): void {
  deps.scheduler.register("cadence.produce", async ({ payload, logger }) => {
    const outcome = await produceForSlot(deps, payload.itemId);
    if (outcome.kind === "failed") {
      throw new TaskFailure(outcome.code, outcome.message, { retryable: false });
    }
    if (outcome.kind !== "started") {
      logger.info({ itemId: payload.itemId, outcome: outcome.kind }, "cadence.produce skipped");
    }
  });
}
