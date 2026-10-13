import {
  allowedActions,
  type ContentAction,
  type ContentActionRequest,
  DEFAULT_FORMAT_RULES,
  DEFAULT_PRODUCE_TARGET,
  type FormatSnapshot,
  IdSchema,
  type JobType,
  nextProductionStep,
  type PipelineState,
  PRODUCE_TARGETS,
  PRODUCTION_STATES,
  type ProduceTarget,
  stageForArtifacts,
  type UserRole,
} from "@loomcast/contracts";
import {
  type AssetRow,
  assets,
  type ContentItemRow,
  type ContentVersionRow,
  type Database,
  type JobRow,
  jobs,
  projects,
} from "@loomcast/db";
import { and, count, eq, or, sql } from "drizzle-orm";
import type { EventBus } from "../../lib/bus";
import { type Executor, type Transaction, transaction } from "../../lib/db";
import { conflict, HttpError, notFound } from "../../lib/errors";
import type { PipelineActor } from "../content/actor";
import { versionArtifacts } from "../content/mappers";
import { activeProductionJob, findVersion, lockItem } from "../content/queries";
import { type ContentService, createContentService } from "../content/service";
import { missingArtifact } from "../content/support";
import { createJobsService, type JobsService } from "../jobs/service";

/** The single production steps, one job each. `produce` chains them. */
export type ProductionStepAction = Exclude<ContentAction, "produce">;

/** The job type each single step runs. */
export const STEP_JOB_TYPES = {
  write_script: "content.write_script",
  storyboard: "content.storyboard",
  voice: "content.voice",
  render: "content.render",
  revise: "content.revise",
} as const satisfies Record<ProductionStepAction, JobType>;

export type ProductionJobType = (typeof STEP_JOB_TYPES)[ProductionStepAction];

/** The artifact each step needs on the current version before it can run. */
const STEP_NEEDS = {
  write_script: null,
  storyboard: "script",
  voice: "storyboard",
  render: "voice",
  revise: "script",
} as const satisfies Record<ProductionStepAction, string | null>;

/** States in which production work may start, as in the contracts' `allowedActions`. */
const ACTION_STATES: readonly PipelineState[] = [...PRODUCTION_STATES, "review"];

/** States past production: `produce` has nothing left to do. */
const PRODUCED_STATES: readonly PipelineState[] = ["review", "approved", "scheduled", "published"];

const ACTIVE_JOB_STATUSES: readonly JobRow["status"][] = ["queued", "dispatched", "running"];

/**
 * The idempotency key of a step: `<action>:<itemId>:<versionId>`. A step that already ran on the
 * version (a failed attempt, or a result that could not be used) gets `:<n>` appended, so it can
 * run again.
 */
export function stepKey(action: ProductionStepAction, itemId: string, versionId: string): string {
  return `${action}:${itemId}:${versionId}`;
}

/** What `produce` does next with an item, given where autopilot should stop. */
export type AutopilotMove =
  | { kind: "step"; step: ProductionStepAction }
  | { kind: "submit" }
  | { kind: "done" };

/**
 * The next autopilot move for an item in `state` on a version with these artifacts: the first
 * missing step, sending a rendered version to review, or nothing once `target` is reached.
 */
export function autopilotMove(
  state: PipelineState,
  version: Parameters<typeof stageForArtifacts>[0],
  target: ProduceTarget,
): AutopilotMove {
  if (PRODUCED_STATES.includes(state) || state === "archived") {
    return { kind: "done" };
  }
  const stage = stageForArtifacts(version);
  if (target !== "review") {
    if (PRODUCE_TARGETS.indexOf(stage as ProduceTarget) >= PRODUCE_TARGETS.indexOf(target)) {
      return { kind: "done" };
    }
  }
  const step = nextProductionStep(version);
  if (step !== null) {
    return { kind: "step", step };
  }
  return target === "review" ? { kind: "submit" } : { kind: "done" };
}

export interface ProductionService {
  /**
   * `POST /api/content/:id/actions`: starts one step, or `produce` (autopilot up to `through`).
   * 404 for an unknown item; 409 `job_in_progress` while a production job of the item is active;
   * 409 `invalid_transition` when the item's state allows no production work; 422
   * `missing_artifact` when the step's input is missing; 422 `voice_not_configured` for a voice
   * without a format voice; 409 `conflict` (`nothing_to_produce`) for `produce` on an item that
   * already reached its target.
   */
  start(
    itemId: string,
    request: ContentActionRequest,
    actor: PipelineActor,
    role: UserRole | null,
  ): Promise<JobRow>;
}

export interface ProductionServiceDeps {
  db: Database;
  bus: EventBus;
  jobs?: JobsService;
  content?: ContentService;
  /** Reads asset rows; defaults to a query on `db`. */
  assets?: { getRow(id: string, executor?: Executor): Promise<AssetRow | null> };
}

const itemNotFound = () => notFound("No content item has that id.");

function jobInProgress(job: JobRow): HttpError {
  return new HttpError(
    409,
    "job_in_progress",
    "This item already has a production job queued or running.",
    { jobId: job.id, type: job.type },
  );
}

function stateRefuses(state: PipelineState, action: ContentAction): HttpError {
  return new HttpError(
    409,
    "invalid_transition",
    `No production work can start on an item in ${state}.`,
    { from: state, action },
  );
}

function voiceNotConfigured(): HttpError {
  return new HttpError(
    422,
    "voice_not_configured",
    "Choose a voice in the format before making the voice.",
  );
}

/** A production job's step, or null for other job types. */
export function stepOfJobType(type: JobType): ProductionStepAction | null {
  for (const [step, jobType] of Object.entries(STEP_JOB_TYPES)) {
    if (jobType === type) return step as ProductionStepAction;
  }
  return null;
}

interface StepExtras {
  reviewId?: string;
  instructions?: string;
}

export function createProductionService(deps: ProductionServiceDeps): ProductionService {
  const { db, bus } = deps;
  const jobsService = deps.jobs ?? createJobsService({ db, bus });
  const assetRows = deps.assets ?? {
    async getRow(id: string, executor: Executor = db): Promise<AssetRow | null> {
      if (!IdSchema.safeParse(id).success) return null;
      const [row] = await executor.select().from(assets).where(eq(assets.id, id)).limit(1);
      return row ?? null;
    },
  };
  const content = deps.content ?? createContentService({ db, bus, assets: assetRows });

  /** The account production jobs of an item run for when no user asked: its creator or owner. */
  async function ownerOf(tx: Transaction, item: ContentItemRow): Promise<string> {
    if (item.createdBy !== null) return item.createdBy;
    const [project] = await tx
      .select({ createdBy: projects.createdBy })
      .from(projects)
      .where(eq(projects.id, item.projectId))
      .limit(1);
    if (project === undefined) throw new Error("content item without its project");
    return project.createdBy;
  }

  async function currentVersion(tx: Transaction, item: ContentItemRow) {
    const version = await findVersion(tx, item.id, item.currentVersionId);
    if (version === null) throw new Error("content item without its current version");
    return version;
  }

  async function formatOf(tx: Transaction, itemId: string): Promise<FormatSnapshot> {
    return (
      (await content.formatSnapshot(itemId, tx)) ?? {
        formatVersionId: null,
        rules: structuredClone(DEFAULT_FORMAT_RULES),
      }
    );
  }

  /** The job payload of a step on `version`. Throws 422 before anything is written. */
  async function payloadFor(
    tx: Transaction,
    step: ProductionStepAction,
    item: ContentItemRow,
    version: ContentVersionRow,
    extras: StepExtras,
  ): Promise<Record<string, unknown>> {
    const needs = STEP_NEEDS[step];
    if (needs !== null) {
      const reached = PRODUCTION_STATES.indexOf(stageForArtifacts(versionArtifacts(version)));
      if (reached < PRODUCTION_STATES.indexOf(needs)) {
        throw missingArtifact(`The current version has no ${needs} yet.`, needs);
      }
    }
    const format = await formatOf(tx, item.id);
    const base = { projectId: item.projectId, itemId: item.id, versionId: version.id, format };
    switch (step) {
      case "voice": {
        const { voiceId, voiceSpeed } = format.rules;
        if (voiceId === undefined) throw voiceNotConfigured();
        return {
          ...base,
          voice: { voiceId, ...(voiceSpeed === undefined ? {} : { speed: voiceSpeed }) },
        };
      }
      case "render":
        if (version.voiceAssetId === null) {
          throw missingArtifact("The current version has no voice yet.", "voice");
        }
        return { ...base, voiceAssetId: version.voiceAssetId };
      case "revise":
        return {
          ...base,
          ...(extras.reviewId === undefined ? {} : { reviewId: extras.reviewId }),
          ...(extras.instructions === undefined ? {} : { instructions: extras.instructions }),
        };
      default:
        return base;
    }
  }

  /**
   * Enqueues a step once per version. A finished job already holding the plain key (a failed
   * attempt) leaves the key taken, so the retry gets the next free `:<n>` suffix.
   */
  async function enqueueStep(
    tx: Transaction,
    item: ContentItemRow,
    version: ContentVersionRow,
    step: ProductionStepAction,
    createdBy: string,
    extras: StepExtras = {},
  ): Promise<JobRow> {
    const payload = await payloadFor(tx, step, item, version, extras);
    const type = STEP_JOB_TYPES[step];
    const key = stepKey(step, item.id, version.id);
    const input = { type, payload, projectId: item.projectId, createdBy };
    const first = await jobsService.enqueue(tx, { ...input, idempotencyKey: key });
    if (first.created || ACTIVE_JOB_STATUSES.includes(first.job.status)) {
      return first.job;
    }
    const [used] = await tx
      .select({ n: count() })
      .from(jobs)
      .where(
        and(
          eq(jobs.createdBy, createdBy),
          or(eq(jobs.idempotencyKey, key), sql`starts_with(${jobs.idempotencyKey}, ${`${key}:`})`),
        ),
      );
    const retry = await jobsService.enqueue(tx, {
      ...input,
      idempotencyKey: `${key}:${(used?.n ?? 1) + 1}`,
    });
    return retry.job;
  }

  /**
   * Starts `produce` on a locked item: records the target and runs the first missing step, sends
   * a rendered version to review, or turns autopilot off once the target is reached.
   */
  async function produceOn(
    tx: Transaction,
    item: ContentItemRow,
    target: ProduceTarget,
    actor: PipelineActor,
    createdBy: string,
  ): Promise<JobRow | null> {
    const version = await currentVersion(tx, item);
    const move = autopilotMove(item.state, versionArtifacts(version), target);
    switch (move.kind) {
      case "step": {
        const job = await enqueueStep(tx, item, version, move.step, createdBy);
        if (item.autopilotTarget !== target) {
          await content.track(tx, item.id, { autopilotTarget: target });
        }
        return job;
      }
      case "submit":
        await content.transition(tx, item.id, "review", actor, {
          via: "submit",
          reason: "autopilot",
        });
        break;
      default:
        break;
    }
    if (item.autopilotTarget !== null) {
      await content.track(tx, item.id, { autopilotTarget: null });
    }
    return null;
  }

  return {
    async start(itemId, request, actor, role) {
      if (!IdSchema.safeParse(itemId).success) throw itemNotFound();
      return transaction(db, async (tx) => {
        const item = await lockItem(tx, itemId);
        if (item === null) throw itemNotFound();
        const active = await activeProductionJob(tx, item);
        if (active !== null) throw jobInProgress(active);
        const version = await currentVersion(tx, item);
        const artifacts = versionArtifacts(version);
        const { action } = request;
        if (!allowedActions(item.state, actor.kind, role, artifacts).includes(action)) {
          if (
            !ACTION_STATES.includes(item.state) ||
            (action === "produce" && item.state === "review")
          ) {
            throw stateRefuses(item.state, action);
          }
          const needs = action === "produce" ? null : STEP_NEEDS[action];
          if (needs !== null) {
            throw missingArtifact(`The current version has no ${needs} yet.`, needs);
          }
          throw stateRefuses(item.state, action);
        }
        const createdBy = actor.userId ?? (await ownerOf(tx, item));
        if (action === "produce") {
          const target = request.through ?? DEFAULT_PRODUCE_TARGET;
          const move = autopilotMove(item.state, artifacts, target);
          if (move.kind !== "step") {
            throw conflict("The item has already been produced up to that point.", {
              reason: "nothing_to_produce",
              through: target,
            });
          }
          const job = await produceOn(tx, item, target, actor, createdBy);
          if (job === null) throw new Error("produce started no job");
          return job;
        }
        const job = await enqueueStep(tx, item, version, action, createdBy);
        // A single step is manual work: autopilot stays off until the next `produce`.
        if (item.autopilotTarget !== null) {
          await content.track(tx, item.id, { autopilotTarget: null });
        }
        return job;
      });
    },
  };
}
