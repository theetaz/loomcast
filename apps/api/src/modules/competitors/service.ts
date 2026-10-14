import {
  ACTIVE_COMPETITOR_SCAN_STATUSES,
  COMPETITOR_SCAN_DEFAULT_VIDEOS,
  COMPETITORS_PER_PROJECT_MAX,
  type Competitor,
  type CompetitorPlatform,
  type CompetitorScan,
  type CompetitorScanSummary,
  CompetitorUrlError,
  type CreateCompetitorRequest,
  type CreateCompetitorScanRequest,
  competitorTag,
  IdSchema,
  KB_TITLE_MAX_LENGTH,
  parseCompetitorUrl,
  type UpdateCompetitorRequest,
} from "@loomcast/contracts";
import {
  type CompetitorRow,
  type CompetitorScanRow,
  competitorScans,
  competitorScanVideos,
  competitors,
  kbEntries,
  kbReferences,
  projects,
} from "@loomcast/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import { type Executor, isUniqueViolation, type Transaction, transaction } from "../../lib/db";
import { conflict, HttpError, validationFailed } from "../../lib/errors";
import type { JobLifecycle } from "../jobs/lifecycle";
import type { JobsService } from "../jobs/service";
import { auditActor, type KbActor, type KbService, requireActiveProject } from "../kb/service";
import {
  type Discovery,
  type DiscoveryDeps,
  discoverInstagramVideos,
  linkedVideos,
  type PickedVideo,
  unprocessable,
} from "./discovery";
import { ACTIVE_JOB_STATUSES, advanceScan, finishScan, scanAnalysisKey } from "./progress";

/** Most scans `listScans` returns. */
export const COMPETITOR_SCANS_LIST_LIMIT = 50;

/** Characters of a caption a reference title starts with. */
const TITLE_CAPTION_LENGTH = 60;

export interface CompetitorsService {
  /** Live competitors of a project, oldest first. Null when the project is unknown. */
  list(projectId: string): Promise<Competitor[] | null>;
  /**
   * Follows the profile `input.url` (`parseCompetitorUrl`). 400 for a link that is not a profile,
   * 404 for an unknown project, 409 for an archived one, 409 `conflict` (`reason: "duplicate"`)
   * when the project already follows it and (`reason: "limit"`) at `COMPETITORS_PER_PROJECT_MAX`.
   */
  create(projectId: string, input: CreateCompetitorRequest, actor: KbActor): Promise<Competitor>;
  get(id: string): Promise<Competitor | null>;
  update(id: string, input: UpdateCompetitorRequest, actor: KbActor): Promise<Competitor | null>;
  /** Soft-deletes a competitor and cancels its active scan. False when there is no such competitor. */
  remove(id: string, actor: KbActor): Promise<boolean>;
  /** Scans of a live competitor, newest first. Null when there is no such competitor. */
  listScans(competitorId: string): Promise<CompetitorScan[] | null>;
  /**
   * Picks the videos (Business Discovery or the pasted links), then in one transaction creates
   * the scan, a reference per video and an analysis job per reference without a finished
   * analysis. See `CreateCompetitorScanRequestSchema` for the errors. Null when there is no such
   * competitor.
   */
  startScan(
    competitorId: string,
    input: CreateCompetitorScanRequest,
    actor: KbActor,
  ): Promise<CompetitorScan | null>;
  getScan(id: string): Promise<CompetitorScan | null>;
  /**
   * Marks an active scan `cancelled`, then cancels the analysis jobs it queued and its report job.
   * A finished scan is returned as it is. Null when there is no such scan.
   */
  cancelScan(id: string, actor: KbActor): Promise<CompetitorScan | null>;
}

export interface CompetitorsServiceDeps extends DiscoveryDeps {
  jobs: JobsService;
  kb: KbService;
  lifecycle: JobLifecycle;
}

const scanInProgress = (scanId: string | null) =>
  new HttpError(409, "scan_in_progress", "A scan of this competitor is still running.", {
    scanId,
  });

/** `count(*)` of a scan's videos, as a correlated subquery. */
const videoCount = sql<number>`(select count(*)::int from ${competitorScanVideos} where ${competitorScanVideos.scanId} = ${competitorScans.id})`;

const summaryColumns = {
  id: competitorScans.id,
  competitorId: competitorScans.competitorId,
  status: competitorScans.status,
  source: competitorScans.source,
  createdAt: competitorScans.createdAt,
  finishedAt: competitorScans.finishedAt,
  videoCount,
};

type SummaryRow = {
  id: string;
  competitorId: string;
  status: CompetitorScanRow["status"];
  source: CompetitorScanRow["source"];
  createdAt: Date;
  finishedAt: Date | null;
  videoCount: number;
};

function toSummary(row: SummaryRow): CompetitorScanSummary {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    videoCount: Number(row.videoCount),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function toCompetitor(
  row: CompetitorRow,
  latestScan: CompetitorScanSummary | null,
  latestReportEntryId: string | null,
): Competitor {
  return {
    id: row.id,
    projectId: row.projectId,
    platform: row.platform,
    handle: row.handle,
    profileUrl: row.profileUrl,
    notes: row.notes,
    account: {
      displayName: row.displayName,
      followersCount: row.followersCount,
      mediaCount: row.mediaCount,
    },
    latestScan,
    latestReportEntryId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `@nasa · How the rover lands`, or `@nasa video 3` without a caption. */
export function scanVideoTitle(handle: string, rank: number, caption: string | null): string {
  const text = (caption ?? "").replace(/\s+/g, " ").trim();
  const title =
    text === ""
      ? `@${handle} video ${rank}`
      : `@${handle} · ${text.length > TITLE_CAPTION_LENGTH ? `${text.slice(0, TITLE_CAPTION_LENGTH).trimEnd()}…` : text}`;
  return title.slice(0, KB_TITLE_MAX_LENGTH);
}

export function createCompetitorsService(deps: CompetitorsServiceDeps): CompetitorsService {
  const { db, jobs, kb, lifecycle } = deps;

  async function loadCompetitor(executor: Executor, id: string): Promise<CompetitorRow | null> {
    if (!IdSchema.safeParse(id).success) {
      return null;
    }
    const [row] = await executor
      .select()
      .from(competitors)
      .where(and(eq(competitors.id, id), isNull(competitors.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async function lockCompetitor(tx: Transaction, id: string): Promise<CompetitorRow | null> {
    if (!IdSchema.safeParse(id).success) {
      return null;
    }
    const [row] = await tx
      .select()
      .from(competitors)
      .where(and(eq(competitors.id, id), isNull(competitors.deletedAt)))
      .limit(1)
      .for("update");
    return row ?? null;
  }

  /** The latest scan and the latest finished report of each competitor. */
  async function withScans(executor: Executor, rows: CompetitorRow[]): Promise<Competitor[]> {
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.id);
    const latest = await executor
      .selectDistinctOn([competitorScans.competitorId], summaryColumns)
      .from(competitorScans)
      .where(inArray(competitorScans.competitorId, ids))
      .orderBy(
        competitorScans.competitorId,
        desc(competitorScans.createdAt),
        desc(competitorScans.id),
      );
    const reports = await executor
      .selectDistinctOn([competitorScans.competitorId], {
        competitorId: competitorScans.competitorId,
        reportEntryId: competitorScans.reportEntryId,
      })
      .from(competitorScans)
      .innerJoin(kbEntries, eq(kbEntries.id, competitorScans.reportEntryId))
      .where(
        and(
          inArray(competitorScans.competitorId, ids),
          inArray(competitorScans.status, ["done", "partial"]),
          isNull(kbEntries.deletedAt),
        ),
      )
      .orderBy(
        competitorScans.competitorId,
        desc(competitorScans.createdAt),
        desc(competitorScans.id),
      );
    const latestBy = new Map(latest.map((row) => [row.competitorId, toSummary(row)]));
    const reportBy = new Map(reports.map((row) => [row.competitorId, row.reportEntryId]));
    return rows.map((row) =>
      toCompetitor(row, latestBy.get(row.id) ?? null, reportBy.get(row.id) ?? null),
    );
  }

  async function oneWithScans(executor: Executor, row: CompetitorRow): Promise<Competitor> {
    const [competitor] = await withScans(executor, [row]);
    if (competitor === undefined) {
      throw new Error("competitor vanished while it was read");
    }
    return competitor;
  }

  async function scanDetails(
    executor: Executor,
    scans: CompetitorScanRow[],
  ): Promise<CompetitorScan[]> {
    if (scans.length === 0) {
      return [];
    }
    const videos = await executor
      .select({
        scanId: competitorScanVideos.scanId,
        rank: competitorScanVideos.rank,
        entryId: competitorScanVideos.entryId,
        url: competitorScanVideos.url,
        caption: competitorScanVideos.caption,
        views: competitorScanVideos.views,
        likes: competitorScanVideos.likes,
        comments: competitorScanVideos.comments,
        postedAt: competitorScanVideos.postedAt,
        analysisStatus: kbReferences.analysisStatus,
      })
      .from(competitorScanVideos)
      .leftJoin(kbReferences, eq(kbReferences.entryId, competitorScanVideos.entryId))
      .where(
        inArray(
          competitorScanVideos.scanId,
          scans.map((scan) => scan.id),
        ),
      )
      .orderBy(asc(competitorScanVideos.rank));
    return scans.map((scan) => {
      const own = videos.filter((video) => video.scanId === scan.id);
      return {
        id: scan.id,
        competitorId: scan.competitorId,
        projectId: scan.projectId,
        status: scan.status,
        source: scan.source,
        topN: scan.topN,
        videoCount: own.length,
        videos: own.map((video) => ({
          rank: video.rank,
          entryId: video.entryId,
          url: video.url,
          caption: video.caption,
          metrics: {
            views: video.views,
            likes: video.likes,
            comments: video.comments,
            postedAt: video.postedAt?.toISOString() ?? null,
          },
          analysisStatus: video.analysisStatus ?? "none",
        })),
        reportEntryId: scan.reportEntryId,
        error: scan.error,
        createdBy: scan.createdBy,
        createdAt: scan.createdAt.toISOString(),
        finishedAt: scan.finishedAt?.toISOString() ?? null,
      };
    });
  }

  async function loadScan(executor: Executor, id: string): Promise<CompetitorScan | null> {
    if (!IdSchema.safeParse(id).success) {
      return null;
    }
    const [scan] = await executor
      .select({ scan: competitorScans })
      .from(competitorScans)
      .innerJoin(competitors, eq(competitors.id, competitorScans.competitorId))
      .where(and(eq(competitorScans.id, id), isNull(competitors.deletedAt)))
      .limit(1);
    if (scan === undefined) {
      return null;
    }
    const [detail] = await scanDetails(executor, [scan.scan]);
    return detail ?? null;
  }

  async function activeScanId(executor: Executor, competitorId: string): Promise<string | null> {
    const [active] = await executor
      .select({ id: competitorScans.id })
      .from(competitorScans)
      .where(
        and(
          eq(competitorScans.competitorId, competitorId),
          inArray(competitorScans.status, [...ACTIVE_COMPETITOR_SCAN_STATUSES]),
        ),
      )
      .limit(1);
    return active?.id ?? null;
  }

  /**
   * Requests cancellation of the jobs a cancelled scan started: its own analysis jobs (never an
   * analysis it only waited for) and its report job.
   */
  async function cancelScanJobs(scanIds: readonly string[]): Promise<void> {
    if (scanIds.length === 0) {
      return;
    }
    const videos = await db
      .select({ scanId: competitorScanVideos.scanId, jobId: competitorScanVideos.analysisJobId })
      .from(competitorScanVideos)
      .where(
        and(
          inArray(competitorScanVideos.scanId, [...scanIds]),
          isNotNull(competitorScanVideos.analysisJobId),
        ),
      );
    const scans = await db
      .select({ reportJobId: competitorScans.reportJobId })
      .from(competitorScans)
      .where(
        and(inArray(competitorScans.id, [...scanIds]), isNotNull(competitorScans.reportJobId)),
      );
    const candidates = [
      ...videos.map((video) => ({ jobId: video.jobId, key: `competitor:${video.scanId}:` })),
      ...scans.map((scan) => ({ jobId: scan.reportJobId, key: null })),
    ];
    for (const { jobId, key } of candidates) {
      const job = jobId === null ? null : await jobs.get(jobId);
      if (
        job !== null &&
        ACTIVE_JOB_STATUSES.has(job.status) &&
        (key === null || job.idempotencyKey?.startsWith(key) === true)
      ) {
        await lifecycle.requestCancel(job.id);
      }
    }
  }

  async function pickVideos(
    competitor: CompetitorRow,
    input: CreateCompetitorScanRequest,
  ): Promise<{ videos: PickedVideo[]; discovery: Discovery | null }> {
    if (input.links !== undefined) {
      return { videos: linkedVideos(input.links, competitor.platform), discovery: null };
    }
    if (competitor.platform !== "instagram") {
      throw unprocessable(
        "links_required",
        "Paste links to the videos: only Instagram accounts can be ranked automatically.",
      );
    }
    const discovery = await discoverInstagramVideos(deps, {
      handle: competitor.handle,
      topN: input.topN ?? COMPETITOR_SCAN_DEFAULT_VIDEOS,
      channelId: input.channelId,
    });
    return { videos: discovery.videos, discovery };
  }

  /** The reference of one picked video, its analysis job when one is needed, and its scan row. */
  async function addVideo(
    tx: Transaction,
    competitor: CompetitorRow,
    scanId: string,
    rank: number,
    video: PickedVideo,
    actor: KbActor,
  ): Promise<string | null> {
    const platform: CompetitorPlatform = competitor.platform;
    const { entry, reference } = await kb.ensureReference(
      tx,
      competitor.projectId,
      {
        kind: "reference",
        url: video.url,
        platform,
        title: scanVideoTitle(competitor.handle, rank, video.caption),
        author: competitor.handle,
        tags: ["competitor", competitorTag(platform, competitor.handle)],
      },
      actor,
    );
    const job =
      reference.analysisStatus === "done"
        ? null
        : await kb.queuePublicVideoAnalysis(tx, entry.id, scanAnalysisKey(scanId, entry.id), actor);
    await tx.insert(competitorScanVideos).values({
      scanId,
      entryId: entry.id,
      rank,
      analysisJobId: job?.id ?? null,
      externalId: video.externalId,
      url: video.url,
      caption: video.caption,
      views: video.views,
      likes: video.likes,
      comments: video.comments,
      postedAt: video.postedAt,
    });
    return job?.id ?? null;
  }

  return {
    async list(projectId) {
      if (!IdSchema.safeParse(projectId).success) {
        return null;
      }
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (project === undefined) {
        return null;
      }
      const rows = await db
        .select()
        .from(competitors)
        .where(and(eq(competitors.projectId, projectId), isNull(competitors.deletedAt)))
        .orderBy(asc(competitors.createdAt), asc(competitors.id));
      return withScans(db, rows);
    },

    async create(projectId, input, actor) {
      let profile: ReturnType<typeof parseCompetitorUrl>;
      try {
        profile = parseCompetitorUrl(input.url);
      } catch (error) {
        if (error instanceof CompetitorUrlError) {
          throw validationFailed([{ path: "url", message: error.message }]);
        }
        throw error;
      }
      try {
        return await transaction(db, async (tx) => {
          await requireActiveProject(tx, projectId);
          // Serialises follows within the project, so the limit and the duplicate check hold.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`loomcast:competitors:${projectId}`}))`,
          );
          const live = await tx
            .select({
              id: competitors.id,
              platform: competitors.platform,
              handle: competitors.handle,
            })
            .from(competitors)
            .where(and(eq(competitors.projectId, projectId), isNull(competitors.deletedAt)));
          const duplicate = live.find(
            (row) =>
              row.platform === profile.platform &&
              row.handle.toLowerCase() === profile.handle.toLowerCase(),
          );
          if (duplicate !== undefined) {
            throw conflict("The project already follows this profile.", {
              reason: "duplicate",
              competitorId: duplicate.id,
            });
          }
          if (live.length >= COMPETITORS_PER_PROJECT_MAX) {
            throw conflict(
              `A project follows at most ${COMPETITORS_PER_PROJECT_MAX} competitors.`,
              {
                reason: "limit",
                max: COMPETITORS_PER_PROJECT_MAX,
              },
            );
          }
          const notes = input.notes === undefined || input.notes === "" ? null : input.notes;
          const [row] = await tx
            .insert(competitors)
            .values({
              projectId,
              platform: profile.platform,
              handle: profile.handle,
              profileUrl: profile.profileUrl,
              notes,
              createdBy: actor.userId,
            })
            .returning();
          if (row === undefined) {
            throw new Error("competitor was not inserted");
          }
          await audit(tx, {
            ...auditActor(actor),
            action: "competitor.create",
            targetType: "competitor",
            targetId: row.id,
            data: { projectId, platform: row.platform, handle: row.handle },
          });
          return toCompetitor(row, null, null);
        });
      } catch (error) {
        if (isUniqueViolation(error, "competitors_project_id_platform_handle_uq")) {
          throw conflict("The project already follows this profile.", { reason: "duplicate" });
        }
        throw error;
      }
    },

    async get(id) {
      const row = await loadCompetitor(db, id);
      return row === null ? null : oneWithScans(db, row);
    },

    update(id, input, actor) {
      return transaction(db, async (tx) => {
        const existing = await lockCompetitor(tx, id);
        if (existing === null) {
          return null;
        }
        const notes = input.notes === null || input.notes === "" ? null : input.notes;
        const [row] = await tx
          .update(competitors)
          .set({ notes })
          .where(eq(competitors.id, existing.id))
          .returning();
        if (row === undefined) {
          return null;
        }
        await audit(tx, {
          ...auditActor(actor),
          action: "competitor.update",
          targetType: "competitor",
          targetId: row.id,
          data: { projectId: row.projectId, fields: ["notes"] },
        });
        return oneWithScans(tx, row);
      });
    },

    async remove(id, actor) {
      const removed = await transaction(db, async (tx) => {
        const existing = await lockCompetitor(tx, id);
        if (existing === null) {
          return null;
        }
        await tx
          .update(competitors)
          .set({ deletedAt: sql`now()` })
          .where(eq(competitors.id, existing.id));
        const cancelled = await tx
          .update(competitorScans)
          .set({ status: "cancelled", finishedAt: sql`now()` })
          .where(
            and(
              eq(competitorScans.competitorId, existing.id),
              inArray(competitorScans.status, [...ACTIVE_COMPETITOR_SCAN_STATUSES]),
            ),
          )
          .returning({ id: competitorScans.id });
        await audit(tx, {
          ...auditActor(actor),
          action: "competitor.delete",
          targetType: "competitor",
          targetId: existing.id,
          data: {
            projectId: existing.projectId,
            cancelledScans: cancelled.map((scan) => scan.id),
          },
        });
        return cancelled.map((scan) => scan.id);
      });
      if (removed === null) {
        return false;
      }
      await cancelScanJobs(removed);
      return true;
    },

    async listScans(competitorId) {
      const competitor = await loadCompetitor(db, competitorId);
      if (competitor === null) {
        return null;
      }
      const scans = await db
        .select()
        .from(competitorScans)
        .where(eq(competitorScans.competitorId, competitor.id))
        .orderBy(desc(competitorScans.createdAt), desc(competitorScans.id))
        .limit(COMPETITOR_SCANS_LIST_LIMIT);
      return scanDetails(db, scans);
    },

    async startScan(competitorId, input, actor) {
      const competitor = await loadCompetitor(db, competitorId);
      if (competitor === null) {
        return null;
      }
      // Checked before the Graph API is called, and again under the competitor's lock.
      const active = await activeScanId(db, competitor.id);
      if (active !== null) {
        throw scanInProgress(active);
      }
      const { videos, discovery } = await pickVideos(competitor, input);

      let scanId: string;
      try {
        scanId = await transaction(db, async (tx) => {
          await requireActiveProject(tx, competitor.projectId);
          const locked = await lockCompetitor(tx, competitor.id);
          if (locked === null) {
            throw new HttpError(404, "not_found", "No competitor has that id.");
          }
          const running = await activeScanId(tx, locked.id);
          if (running !== null) {
            throw scanInProgress(running);
          }
          if (discovery !== null) {
            await tx
              .update(competitors)
              .set({
                displayName: discovery.account.displayName,
                followersCount: discovery.account.followersCount,
                mediaCount: discovery.account.mediaCount,
              })
              .where(eq(competitors.id, locked.id));
          }
          const [scan] = await tx
            .insert(competitorScans)
            .values({
              competitorId: locked.id,
              projectId: locked.projectId,
              status: "analyzing",
              source: discovery === null ? "links" : "official_api",
              // A scan of pasted links analyses exactly those links.
              topN:
                discovery === null ? videos.length : (input.topN ?? COMPETITOR_SCAN_DEFAULT_VIDEOS),
              channelId: discovery?.channelId ?? null,
              createdBy: actor.userId,
            })
            .returning({ id: competitorScans.id });
          if (scan === undefined) {
            throw new Error("competitor scan was not inserted");
          }
          let waiting = 0;
          for (const [index, video] of videos.entries()) {
            const jobId = await addVideo(tx, locked, scan.id, index + 1, video, actor);
            waiting += jobId === null ? 0 : 1;
          }
          await audit(tx, {
            ...auditActor(actor),
            action: "competitor.scan.start",
            targetType: "competitor_scan",
            targetId: scan.id,
            data: {
              projectId: locked.projectId,
              competitorId: locked.id,
              source: discovery === null ? "links" : "official_api",
              videoCount: videos.length,
              analyses: waiting,
            },
          });
          if (waiting === 0) {
            // Every video was analysed before: straight to the report.
            await advanceScan(tx, jobs, scan.id);
          }
          return scan.id;
        });
      } catch (error) {
        if (isUniqueViolation(error, "competitor_scans_one_active_uq")) {
          throw scanInProgress(null);
        }
        throw error;
      }
      // An analysis the scan reused may have ended before the scan was committed; its hook could
      // not see the scan then.
      await transaction(db, (tx) => advanceScan(tx, jobs, scanId));
      return loadScan(db, scanId);
    },

    getScan(id) {
      return loadScan(db, id);
    },

    async cancelScan(id, actor) {
      const found = await loadScan(db, id);
      if (found === null) {
        return null;
      }
      const changed = await transaction(db, async (tx) => {
        const [scan] = await tx
          .select({ id: competitorScans.id, status: competitorScans.status })
          .from(competitorScans)
          .where(eq(competitorScans.id, found.id))
          .limit(1)
          .for("update");
        if (
          scan === undefined ||
          !(ACTIVE_COMPETITOR_SCAN_STATUSES as readonly string[]).includes(scan.status)
        ) {
          return false;
        }
        await finishScan(tx, scan.id, "cancelled");
        await audit(tx, {
          ...auditActor(actor),
          action: "competitor.scan.cancel",
          targetType: "competitor_scan",
          targetId: scan.id,
          data: { projectId: found.projectId, competitorId: found.competitorId },
        });
        return true;
      });
      if (changed) {
        await cancelScanJobs([found.id]);
      }
      return loadScan(db, found.id);
    },
  };
}
