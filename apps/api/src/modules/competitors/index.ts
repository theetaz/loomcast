import {
  CreateCompetitorRequestSchema,
  CreateCompetitorScanRequestSchema,
  routes,
  UpdateCompetitorRequestSchema,
} from "@loomcast/contracts";
import { type Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound } from "../../lib/errors";
import { clientIp, idParam, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { createJobLifecycle } from "../jobs/lifecycle";
import type { KbActor } from "../kb/service";
import { type CompetitorsService, createCompetitorsService } from "./service";

export {
  type Discovery,
  discoverInstagramVideos,
  linkedVideos,
  type PickedVideo,
  rankVideos,
} from "./discovery";
export {
  advanceScan,
  advanceScansOfJob,
  insightsMarkdown,
  reportBody,
  scanAnalysisKey,
  scanReportKey,
} from "./progress";
export {
  COMPETITOR_SCANS_LIST_LIMIT,
  type CompetitorsService,
  type CompetitorsServiceDeps,
  createCompetitorsService,
  scanVideoTitle,
  toCompetitor,
} from "./service";

const competitorNotFound = () => notFound("No competitor has that id.");
const scanNotFound = () => notFound("No competitor scan has that id.");

/** The competitors service of the app, built from its module deps. */
export function competitorsServiceFor(deps: ModuleDeps): CompetitorsService {
  return createCompetitorsService({
    db: deps.db,
    vault: deps.vault,
    platforms: deps.config.platforms,
    logger: deps.logger.child({ module: "competitors" }),
    jobs: deps.jobs,
    kb: deps.kb,
    lifecycle: createJobLifecycle(deps),
  });
}

/**
 * Competitor research endpoints: the competitors a project follows, their scans, starting a scan
 * (the most viewed Instagram videos through Business Discovery, or pasted links) and cancelling
 * one. Every write is audited; the references and the report a scan writes go through the
 * knowledge-base service and publish `kb.entry.*` events. See `docs/competitor-research.md`.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const service = competitorsServiceFor(deps);
  const router = new Hono<AppEnv>();

  function actor(c: Context<AppEnv>): KbActor {
    const user = currentUser(c);
    return {
      kind: "user",
      id: user.id,
      userId: user.id,
      via: "ui",
      ip: clientIp(c, deps.config.trustProxy),
    };
  }

  router.get(routes["competitors.list"].path, async (c) => {
    currentUser(c);
    const items = await service.list(idParam(c, "projectId"));
    if (items === null) {
      throw notFound("Project not found.");
    }
    return c.json({ items }, 200);
  });

  router.post(routes["competitors.create"].path, async (c) => {
    const projectId = idParam(c, "projectId");
    const input = await readJson(c, CreateCompetitorRequestSchema);
    const created = await service.create(projectId, input, actor(c));
    return c.json(created, 201);
  });

  router.get(routes["competitors.get"].path, async (c) => {
    currentUser(c);
    const found = await service.get(idParam(c));
    if (found === null) {
      throw competitorNotFound();
    }
    return c.json(found, 200);
  });

  router.patch(routes["competitors.update"].path, async (c) => {
    const id = idParam(c);
    const input = await readJson(c, UpdateCompetitorRequestSchema);
    const updated = await service.update(id, input, actor(c));
    if (updated === null) {
      throw competitorNotFound();
    }
    return c.json(updated, 200);
  });

  router.delete(routes["competitors.delete"].path, async (c) => {
    const removed = await service.remove(idParam(c), actor(c));
    if (!removed) {
      throw competitorNotFound();
    }
    return c.body(null, 204);
  });

  router.get(routes["competitors.scans"].path, async (c) => {
    currentUser(c);
    const items = await service.listScans(idParam(c));
    if (items === null) {
      throw competitorNotFound();
    }
    return c.json({ items }, 200);
  });

  router.post(routes["competitors.scan"].path, async (c) => {
    const id = idParam(c);
    const input = await readJson(c, CreateCompetitorScanRequestSchema);
    const scan = await service.startScan(id, input, actor(c));
    if (scan === null) {
      throw competitorNotFound();
    }
    return c.json(scan, 201);
  });

  router.get(routes["competitorScans.get"].path, async (c) => {
    currentUser(c);
    const scan = await service.getScan(idParam(c));
    if (scan === null) {
      throw scanNotFound();
    }
    return c.json(scan, 200);
  });

  router.post(routes["competitorScans.cancel"].path, async (c) => {
    const scan = await service.cancelScan(idParam(c), actor(c));
    if (scan === null) {
      throw scanNotFound();
    }
    return c.json(scan, 200);
  });

  app.route("/", router);
  return router;
}
