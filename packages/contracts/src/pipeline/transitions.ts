import { z } from "zod";
import {
  type ActorKind,
  CONTENT_ACTIONS,
  type ContentAction,
  PIPELINE_STATES,
  type PipelineState,
  PRODUCTION_STATES,
  type ProductionState,
  REVIEW_DECISIONS,
  type ReviewDecision,
  type UserRole,
} from "../enums";

// The pipeline state machine. `PIPELINE_TRANSITIONS` is the single source of truth: the API checks
// every state change against it and the web app derives its buttons from it.

/**
 * What moves an item:
 * - `version`: a new version (a job result, an MCP submission or an edit in the web app). The new
 *   state is the version's stage (`stageForArtifacts`).
 * - `submit`: a version with a render goes to review.
 * - `approve`, `request_changes`, `reject`: a review decision.
 * - `edit`: a user changes an approved item; it goes back into production unless only the caption
 *   or notes changed.
 * - `schedule`, `unschedule`, `publish`: the calendar and the publisher (M4).
 * - `archive`, `restore`: an item leaves the pipeline, or comes back as an idea.
 */
export const TRANSITION_VIA = [
  "version",
  "submit",
  "approve",
  "request_changes",
  "reject",
  "edit",
  "schedule",
  "unschedule",
  "publish",
  "archive",
  "restore",
] as const;
export const TransitionViaSchema = z.enum(TRANSITION_VIA);
export type TransitionVia = (typeof TRANSITION_VIA)[number];

/** One allowed move. `from === to` means a new version that leaves the state unchanged. */
export interface PipelineTransition {
  readonly from: PipelineState;
  readonly to: PipelineState;
  readonly via: TransitionVia;
  readonly actors: readonly ActorKind[];
  /** The version the item ends up on must have a render. */
  readonly requiresRender: boolean;
}

/**
 * The artifacts of a version, as far as the state machine cares. A full `ContentVersion` (any
 * non-null `script` or `storyboard` counts) and a `ContentVersionSummary` (`hasScript`,
 * `hasStoryboard`) both fit.
 */
export interface VersionArtifacts {
  readonly script?: unknown;
  readonly hasScript?: boolean;
  readonly storyboard?: unknown;
  readonly hasStoryboard?: boolean;
  readonly voiceAssetId?: string | null;
  readonly renderAssetId?: string | null;
}

const EVERYONE = ["user", "device", "token", "system"] as const satisfies readonly ActorKind[];
const USER = ["user"] as const satisfies readonly ActorKind[];
const USER_OR_SYSTEM = ["user", "system"] as const satisfies readonly ActorKind[];
const SYSTEM = ["system"] as const satisfies readonly ActorKind[];

/** Stages a new version can put an item in; `idea` has no artifacts, so no version leads there. */
const VERSION_STAGES = ["script", "storyboard", "voice", "render"] as const;

function edge(
  from: PipelineState,
  to: PipelineState,
  via: TransitionVia,
  actors: readonly ActorKind[],
  requiresRender = false,
): PipelineTransition {
  return { from, to, via, actors, requiresRender };
}

function buildTransitions(): PipelineTransition[] {
  const rows: PipelineTransition[] = [];

  // Production: any actor may add a version while the item is in production or review. Devices
  // and tokens are limited to these rows and `submit`. A version taken back out of review (for
  // example a regenerated voice) returns the item to the version's stage.
  for (const from of [...PRODUCTION_STATES, "review"] as const) {
    for (const to of VERSION_STAGES) rows.push(edge(from, to, "version", EVERYONE));
  }
  // A user may change only the caption or notes of an item in review and keep it there.
  rows.push(edge("review", "review", "version", USER, true));

  // A version with a render goes to review.
  for (const from of PRODUCTION_STATES) rows.push(edge(from, "review", "submit", EVERYONE, true));

  // Review decisions belong to users. Approval needs a render.
  rows.push(edge("review", "approved", "approve", USER, true));
  rows.push(edge("review", "script", "request_changes", USER));
  rows.push(edge("review", "archived", "reject", USER));

  // Editing an approved item sends it back into production; a caption or notes change keeps it.
  for (const to of ["script", "storyboard", "voice"] as const) {
    rows.push(edge("approved", to, "edit", USER));
  }
  rows.push(edge("approved", "approved", "edit", USER, true));

  // Calendar and publishing (M4): the scheduler acts as `system`.
  rows.push(edge("approved", "scheduled", "schedule", USER_OR_SYSTEM, true));
  rows.push(edge("scheduled", "approved", "unschedule", USER_OR_SYSTEM, true));
  rows.push(edge("scheduled", "published", "publish", SYSTEM, true));

  // Archiving and restoring.
  for (const from of PIPELINE_STATES) {
    if (from !== "archived") rows.push(edge(from, "archived", "archive", USER));
  }
  rows.push(edge("archived", "idea", "restore", USER));

  return rows;
}

/** Every allowed move between pipeline states. Anything not listed is refused. */
export const PIPELINE_TRANSITIONS: readonly PipelineTransition[] = Object.freeze(
  buildTransitions().map((row) => Object.freeze(row)),
);

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function hasRender(version: VersionArtifacts | null | undefined): boolean {
  return version !== null && version !== undefined && hasValue(version.renderAssetId);
}

/**
 * The production stage a version's artifacts reach: the last of script, storyboard, voice and
 * render present without a gap. A version with a voice but no storyboard is at `script`.
 */
export function stageForArtifacts(version: VersionArtifacts): ProductionState {
  if (!hasValue(version.script) && version.hasScript !== true) return "idea";
  if (!hasValue(version.storyboard) && version.hasStoryboard !== true) return "script";
  if (!hasValue(version.voiceAssetId)) return "storyboard";
  if (!hasValue(version.renderAssetId)) return "voice";
  return "render";
}

export interface TransitionQuery {
  readonly from: PipelineState;
  readonly to: PipelineState;
  readonly actor: ActorKind;
  /** Restricts the match to one kind of move. */
  readonly via?: TransitionVia;
  /** The version the item ends up on; rows that need a render are refused without one. */
  readonly version?: VersionArtifacts | null;
}

/** The table row that allows a move, or `undefined` when the move is refused. */
export function findTransition(query: TransitionQuery): PipelineTransition | undefined {
  return PIPELINE_TRANSITIONS.find(
    (row) =>
      row.from === query.from &&
      row.to === query.to &&
      (query.via === undefined || row.via === query.via) &&
      row.actors.includes(query.actor) &&
      (!row.requiresRender || hasRender(query.version)),
  );
}

/**
 * Whether `actor` may move an item from `from` to `to`. `version` is the version the item ends up
 * on; moves that need a render (submitting, approving, scheduling) are refused without one.
 */
export function canTransition(
  from: PipelineState,
  to: PipelineState,
  actor: ActorKind,
  version?: VersionArtifacts | null,
): boolean {
  return findTransition({ from, to, actor, version }) !== undefined;
}

/** The state a review decision moves an item to. */
export const REVIEW_DECISION_STATES = {
  approve: "approved",
  request_changes: "script",
  reject: "archived",
} as const satisfies Record<ReviewDecision, PipelineState>;

/** How far `produce` goes. It stops once the item reaches this state; `review` by default. */
export const PRODUCE_TARGETS = ["script", "storyboard", "voice", "render", "review"] as const;
export const ProduceTargetSchema = z.enum(PRODUCE_TARGETS);
export type ProduceTarget = (typeof PRODUCE_TARGETS)[number];
export const DEFAULT_PRODUCE_TARGET: ProduceTarget = "review";

/** The single-step actions in production order, with the stage each one reaches. */
export const PRODUCTION_STEPS = [
  { action: "write_script", stage: "script" },
  { action: "storyboard", stage: "storyboard" },
  { action: "voice", stage: "voice" },
  { action: "render", stage: "render" },
] as const satisfies readonly { action: ContentAction; stage: ProductionState }[];
export type ProductionStep = (typeof PRODUCTION_STEPS)[number]["action"];

/** The first production step a version still needs, or `null` once it has a render. */
export function nextProductionStep(version: VersionArtifacts): ProductionStep | null {
  const stage = stageForArtifacts(version);
  const reached = PRODUCTION_STATES.indexOf(stage);
  const next = PRODUCTION_STEPS.find((step) => PRODUCTION_STATES.indexOf(step.stage) > reached);
  return next?.action ?? null;
}

/**
 * Everything a user can do to an item: start production work (`CONTENT_ACTIONS`), send a rendered
 * version to review, decide a review, edit, archive and restore.
 */
export const ITEM_ACTIONS = [
  ...CONTENT_ACTIONS,
  "submit",
  ...REVIEW_DECISIONS,
  "edit",
  "archive",
  "restore",
] as const;
export const ItemActionSchema = z.enum(ITEM_ACTIONS);
export type ItemAction = (typeof ITEM_ACTIONS)[number];

/** Actors that may start production work: users in the web app and autopilot. */
const ACTION_ACTORS: readonly ActorKind[] = USER_OR_SYSTEM;

/** States in which production work may start. */
const ACTION_STATES: readonly PipelineState[] = [...PRODUCTION_STATES, "review"];

/** The production stage each content action needs before it can run. */
const ACTION_REQUIRES = {
  write_script: "idea",
  storyboard: "script",
  voice: "storyboard",
  render: "voice",
  revise: "script",
  produce: "idea",
} as const satisfies Record<ContentAction, ProductionState>;

function reachedStage(version: VersionArtifacts | null | undefined, stage: ProductionState) {
  const reached = version ? stageForArtifacts(version) : "idea";
  return PRODUCTION_STATES.indexOf(reached) >= PRODUCTION_STATES.indexOf(stage);
}

function contentActionAllowed(
  action: ContentAction,
  state: PipelineState,
  actor: ActorKind,
  version: VersionArtifacts | null | undefined,
): boolean {
  if (!ACTION_ACTORS.includes(actor) || !ACTION_STATES.includes(state)) return false;
  // `produce` drives an item to review, so it does not start from review itself.
  if (action === "produce" && state === "review") return false;
  return reachedStage(version, ACTION_REQUIRES[action]);
}

function rowAllows(
  state: PipelineState,
  via: TransitionVia,
  actor: ActorKind,
  version: VersionArtifacts | null | undefined,
): boolean {
  return PIPELINE_TRANSITIONS.some(
    (row) =>
      row.from === state &&
      row.via === via &&
      row.actors.includes(actor) &&
      (!row.requiresRender || hasRender(version)),
  );
}

/**
 * The actions `actor` may take on an item in `state` whose current version is `version`. A user
 * needs a role (both roles have the same pipeline rights); other actors pass `null`. Without a
 * version only actions that need no artifacts are offered.
 */
export function allowedActions(
  state: PipelineState,
  actor: ActorKind,
  role: UserRole | null,
  version?: VersionArtifacts | null,
): ItemAction[] {
  if (actor === "user" && role === null) return [];
  return ITEM_ACTIONS.filter((action) => {
    switch (action) {
      case "submit":
      case "approve":
      case "request_changes":
      case "reject":
      case "archive":
      case "restore":
        return rowAllows(state, action, actor, version);
      case "edit":
        // Editing in the web app is for users; producers write versions through jobs and MCP.
        return (
          actor === "user" &&
          (rowAllows(state, "version", actor, version) || rowAllows(state, "edit", actor, version))
        );
      default:
        return contentActionAllowed(action, state, actor, version);
    }
  });
}
