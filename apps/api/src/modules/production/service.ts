import {
  allowedActions,
  type ContentAction,
  type ContentActionRequest,
  type ContentItem,
  type ContentItemError,
  type ContentRenderResult,
  type ContentReviseResult,
  type ContentStoryboardResult,
  type ContentVoiceResult,
  type ContentWriteScriptResult,
  DEFAULT_FORMAT_RULES,
  DEFAULT_PRODUCE_TARGET,
  type FormatSnapshot,
  findTransition,
  IdSchema,
  type JobError,
  type JobType,
  type JsonObject,
  nextProductionStep,
  type PipelineState,
  PRODUCE_TARGETS,
  PRODUCTION_STATES,
  type ProduceTarget,
  type Review,
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
import { type PipelineActor, SYSTEM_ACTOR } from "../content/actor";
import { versionArtifacts } from "../content/mappers";
import { activeProductionJob, findVersion, findVersionOfJob, lockItem } from "../content/queries";
import { type ContentService, createContentService } from "../content/service";
import { missingArtifact } from "../content/support";
import { applyChanges, type VersionChanges } from "../content/versions";
import { createJobsService, type JobsService } from "../jobs/service";
import { fitStoryboard, renderLengthNote, spansOfScript, timeScript } from "./timing";

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

export interface ProduceOptions {
  /** Where autopilot stops; `review` by default. */
  through?: ProduceTarget;
  /** Who asks. Defaults to the server itself (the cadence scheduler). */
  actor?: PipelineActor;
}

export interface ProduceResult {
  item: ContentItem;
  /**
   * The job autopilot is waiting for: the step it started, or the production job that was
   * already running. Null when the item has nothing left to produce up to the target.
   */
  job: JobRow | null;
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
  /**
   * Autopilot for the scheduler (`cadence.produce`): sets the item's autopilot target and starts
   * the first missing step. An item with a production job already running keeps it and continues
   * from its result. An item that already reached the target (or review) gets no job. 404 for an
   * unknown item, 409 `invalid_transition` for an archived one.
   */
  produce(itemId: string, options?: ProduceOptions): Promise<ProduceResult>;
  /**
   * Stores a production job's result as the item's next version (the `onSucceeded` hook). Runs in
   * the job's own transaction, at most once per job: a replayed completion finds the job's version
   * and changes nothing. A result that can no longer be used (the item moved on, or its assets do
   * not check out) is recorded as the item's `lastError` instead, and autopilot stops.
   */
  applyResult(tx: Transaction, job: JobRow, result: JsonObject): Promise<void>;
  /**
   * Records a failed or cancelled production job on its item (`lastError`) and stops autopilot.
   * Idempotent; skipped when a newer production job of the item is already active.
   */
  recordFailure(jobId: string): Promise<void>;
  /**
   * Queues `content.revise` for a `request_changes` review that asked for a revision, and sets
   * autopilot to bring the item back to review. Null when the item has moved on since.
   */
  requestRevision(review: Review): Promise<JobRow | null>;
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

  /** Sets the item's last error and turns autopilot off. */
  async function recordError(
    tx: Transaction,
    itemId: string,
    job: JobRow,
    error: Pick<JobError, "code" | "message">,
  ): Promise<void> {
    const lastError: ContentItemError = {
      jobId: job.id,
      jobType: job.type,
      code: error.code.slice(0, 64),
      message: error.message.slice(0, 2_000),
      at: (job.finishedAt ?? new Date()).toISOString(),
    };
    await content.track(tx, itemId, { lastError, autopilotTarget: null });
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

  /** The artifacts a job result adds to `base`. */
  async function changesFor(
    tx: Transaction,
    step: ProductionStepAction,
    base: ContentVersionRow,
    result: JsonObject,
    format: FormatSnapshot,
  ): Promise<VersionChanges> {
    switch (step) {
      case "write_script": {
        const data = result as unknown as ContentWriteScriptResult;
        return { script: data.script, notes: data.notes ?? null };
      }
      case "storyboard": {
        const data = result as unknown as ContentStoryboardResult;
        return { storyboard: await fitToVoice(tx, data.storyboard, base) };
      }
      case "revise": {
        const data = result as unknown as ContentReviseResult;
        const changes: VersionChanges = { notes: data.summary };
        if (data.script !== undefined) changes.script = data.script;
        if (data.storyboard !== undefined) {
          // A revised script drops the voice, so only a storyboard on the same script is re-timed.
          changes.storyboard =
            data.script === undefined
              ? await fitToVoice(tx, data.storyboard, base)
              : data.storyboard;
        }
        return changes;
      }
      case "voice": {
        const data = result as unknown as ContentVoiceResult;
        const changes: VersionChanges = { voiceAssetId: data.voiceAssetId };
        // The same take again (identical audio) keeps the version's timings as they are.
        const timed =
          base.script === null || data.voiceAssetId === base.voiceAssetId
            ? null
            : timeScript(base.script, data.alignment.words, data.durationMs);
        const spans = spansOfScript(timed);
        if (timed !== null && spans !== null) {
          // The segments get their spoken times, and the storyboard is re-timed to them.
          changes.script = timed;
          if (base.storyboard !== null) {
            changes.storyboard = fitStoryboard(base.storyboard, spans, data.durationMs);
          }
        }
        return changes;
      }
      case "render": {
        const data = result as unknown as ContentRenderResult;
        return {
          renderAssetId: data.renderAssetId,
          posterAssetId: data.posterAssetId,
          notes: renderLengthNote(data.durationMs, format.rules.lengthSec),
        };
      }
    }
  }

  /**
   * A new storyboard for a version that already has a voice is re-timed to it, so a storyboard
   * cut after the voice can never run past it.
   */
  async function fitToVoice(
    tx: Transaction,
    storyboard: ContentStoryboardResult["storyboard"],
    base: ContentVersionRow,
  ) {
    if (base.voiceAssetId === null) return storyboard;
    const spans = spansOfScript(base.script);
    const voice = await assetRows.getRow(base.voiceAssetId, tx);
    if (spans === null || voice?.durationMs == null) return storyboard;
    return fitStoryboard(storyboard, spans, voice.durationMs);
  }

  /** Why the assets a result names cannot be used, or null when they can. */
  async function assetProblem(
    tx: Transaction,
    itemId: string,
    base: ContentVersionRow,
    changes: VersionChanges,
  ): Promise<string | null> {
    const named = [
      ["voice", changes.voiceAssetId, base.voiceAssetId],
      ["render", changes.renderAssetId, base.renderAssetId],
      ["poster", changes.posterAssetId, base.posterAssetId],
    ] as const;
    for (const [kind, id, previous] of named) {
      if (id === undefined || id === previous) continue;
      const row = await assetRows.getRow(id, tx);
      if (row === null || row.itemId !== itemId || row.kind !== kind) {
        return `The job named a ${kind} that is not a ${kind} of this item.`;
      }
      if (row.status !== "ready") {
        return `The job's ${kind} upload was never finished.`;
      }
    }
    return null;
  }

  /** After a step's result: the next autopilot step, a submit, or autopilot off. */
  async function continueAutopilot(tx: Transaction, itemId: string, job: JobRow): Promise<void> {
    const item = await lockItem(tx, itemId);
    if (item === null || item.autopilotTarget === null) return;
    const active = await activeProductionJob(tx, item);
    if (active !== null) return;
    try {
      await produceOn(tx, item, item.autopilotTarget, SYSTEM_ACTOR, job.createdBy);
    } catch (error) {
      // Refused before anything was written (no voice in the format, a missing artifact): the
      // result stays stored and the item shows why autopilot stopped.
      if (error instanceof HttpError) {
        await recordError(tx, itemId, job, { code: error.code, message: error.message });
        return;
      }
      throw error;
    }
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

    async produce(itemId, options = {}) {
      if (!IdSchema.safeParse(itemId).success) throw itemNotFound();
      const target = options.through ?? DEFAULT_PRODUCE_TARGET;
      const actor = options.actor ?? SYSTEM_ACTOR;
      return transaction(db, async (tx) => {
        const item = await lockItem(tx, itemId);
        if (item === null) throw itemNotFound();
        if (item.state === "archived") throw stateRefuses(item.state, "produce");
        let job: JobRow | null = null;
        if (!PRODUCED_STATES.includes(item.state)) {
          const active = await activeProductionJob(tx, item);
          if (active !== null) {
            if (item.autopilotTarget !== target) {
              await content.track(tx, item.id, { autopilotTarget: target });
            }
            job = active;
          } else {
            const createdBy = actor.userId ?? (await ownerOf(tx, item));
            job = await produceOn(tx, item, target, actor, createdBy);
          }
        }
        const current = await content.getItem(item.id, tx);
        if (current === null) throw itemNotFound();
        return { item: current, job };
      });
    },

    async applyResult(tx, job, result) {
      const step = stepOfJobType(job.type);
      const payload = job.payload as { itemId?: unknown; versionId?: unknown; format?: unknown };
      if (
        step === null ||
        typeof payload.itemId !== "string" ||
        typeof payload.versionId !== "string"
      ) {
        return;
      }
      const item = await lockItem(tx, payload.itemId);
      if (item === null || item.state === "archived") return;
      // A replayed completion: the job's version exists, nothing more to do.
      if ((await findVersionOfJob(tx, job.id)) !== null) return;
      if (item.currentVersionId !== payload.versionId) {
        await recordError(tx, item.id, job, {
          code: "stale_version",
          message: "The item changed while the job ran, so its result was not used.",
        });
        return;
      }
      const base = await currentVersion(tx, item);
      const format =
        (payload.format as FormatSnapshot | undefined) ?? (await formatOf(tx, item.id));
      const changes = await changesFor(tx, step, base, result, format);

      const problem = await assetProblem(tx, item.id, base, changes);
      if (problem !== null) {
        await recordError(tx, item.id, job, { code: "invalid_result", message: problem });
        return;
      }
      const next = applyChanges(base, changes);
      const stage = stageForArtifacts(next);
      // A render goes on to review, unless autopilot was asked to stop at the render.
      const toReview = step === "render" && item.autopilotTarget !== "render";
      const to: PipelineState = toReview && item.state !== "review" ? "review" : stage;
      if (findTransition({ from: item.state, to, actor: "device", version: next }) === undefined) {
        await recordError(tx, item.id, job, {
          code: "invalid_transition",
          message: `The item is in ${item.state} now, so the job's result was not used.`,
        });
        return;
      }

      const written = await content.createVersionFromJob(tx, job.id, item.id, changes, {
        baseVersionId: payload.versionId,
        state: to,
        reason: `job:${job.type}`,
      });
      if (!written.created) return;
      if (toReview && to !== "review") {
        // A render made while the item was in review: it leaves review for the new version and
        // goes straight back with it.
        await content.transition(
          tx,
          item.id,
          "review",
          { kind: "device", id: job.claimedByDevice, userId: job.createdBy },
          { via: "submit", reason: `job:${job.type}` },
        );
      }
      await continueAutopilot(tx, item.id, job);
    },

    async recordFailure(jobId) {
      await transaction(db, async (tx) => {
        const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
        if (job === undefined || (job.status !== "failed" && job.status !== "cancelled")) return;
        const itemId = (job.payload as { itemId?: unknown }).itemId;
        if (typeof itemId !== "string" || !IdSchema.safeParse(itemId).success) return;
        const item = await lockItem(tx, itemId);
        if (item === null || item.lastError?.jobId === job.id) return;
        const active = await activeProductionJob(tx, item);
        if (active !== null && active.id !== job.id) return;
        await recordError(tx, item.id, job, {
          code: job.error?.code ?? job.status,
          message: job.error?.message ?? `The ${job.type} job was ${job.status}.`,
        });
      });
    },

    async requestRevision(review) {
      if (review.decision !== "request_changes" || !review.enqueueRevision) return null;
      return transaction(db, async (tx) => {
        const item = await lockItem(tx, review.itemId);
        if (
          item === null ||
          item.currentVersionId !== review.versionId ||
          item.state !== "script"
        ) {
          return null;
        }
        if ((await activeProductionJob(tx, item)) !== null) return null;
        const version = await currentVersion(tx, item);
        const createdBy = review.userId ?? (await ownerOf(tx, item));
        const job = await enqueueStep(tx, item, version, "revise", createdBy, {
          reviewId: review.id,
          ...(review.comment === null ? {} : { instructions: review.comment }),
        });
        // Autopilot brings the revised item back to review.
        await content.track(tx, item.id, { autopilotTarget: "review" });
        return job;
      });
    },
  };
}
