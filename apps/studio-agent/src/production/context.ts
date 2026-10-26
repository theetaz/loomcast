import {
  type ContentItem,
  type ContentVersion,
  type JobPayload,
  type JobType,
  parseJobPayload,
} from "@loomcast/contracts";
import { type JobContext, JobFailure } from "../handlers";
import type { Logger } from "../logger";
import type { ProducerRuntime } from "../producer/runtime";
import { type PlatformClient, type PlatformConnector, PlatformError } from "./platform";
import type { StudioLoader } from "./studio";

/** The fetch the production jobs use for uploads and downloads; tests pass a fake. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Waits between attempts; tests pass one that returns at once. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** What the production handlers share. Tests replace every part. */
export interface ProductionDeps {
  /** `~/Loomcast`: workspaces, items and synced skills live below it. */
  readonly workspaceRoot: string;
  readonly connect: PlatformConnector;
  readonly studio: StudioLoader;
  /** The TTS provider key, read when a job needs it and never stored elsewhere. */
  readonly voiceKey: () => Promise<string | undefined>;
  readonly fetch?: FetchLike;
  readonly sleep?: Sleep;
  readonly now?: () => Date;
  readonly log?: Logger;
}

export interface ProducerStepDeps extends ProductionDeps {
  readonly runtime: ProducerRuntime;
}

/** Validates a production payload and checks it is about the job's workspace. */
export function parsePayload<T extends JobType>(ctx: JobContext<T>): JobPayload<T> {
  const parsed = parseJobPayload(ctx.job.type, ctx.job.payload);
  if (!parsed.success) {
    throw new JobFailure("invalid_payload", `The ${ctx.job.type} payload is invalid`);
  }
  const payload = parsed.data as JobPayload<T>;
  if (
    typeof payload === "object" &&
    payload !== null &&
    "workspaceId" in payload &&
    payload.workspaceId !== ctx.job.workspaceId
  ) {
    throw new JobFailure("invalid_payload", "The payload's workspace does not match the job's");
  }
  return payload;
}

/**
 * Runs `work` with a platform client opened with the job token. A production job cannot run
 * without one: its inputs and outputs live on the platform.
 */
export async function withPlatform<T>(
  ctx: JobContext<JobType>,
  connect: PlatformConnector,
  work: (platform: PlatformClient) => Promise<T>,
): Promise<T> {
  const credentials = ctx.credentials.mcp;
  if (credentials === undefined) {
    throw new JobFailure(
      "missing_credentials",
      "The server sent no job token, so the studio agent cannot reach the item",
      false,
    );
  }
  const platform = await connect(credentials, ctx.signal);
  try {
    return await work(platform);
  } finally {
    await platform.close().catch(() => {});
  }
}

/** The item and the version a job starts from, checked against the payload. */
export async function loadVersion(
  platform: PlatformClient,
  payload: { readonly workspaceId: string; readonly itemId: string; readonly versionId: string },
): Promise<{ item: ContentItem; version: ContentVersion }> {
  const { item, version } = await platform.getContent({
    itemId: payload.itemId,
    versionId: payload.versionId,
  });
  if (
    item.id !== payload.itemId ||
    item.workspaceId !== payload.workspaceId ||
    version.id !== payload.versionId ||
    version.itemId !== payload.itemId
  ) {
    throw new JobFailure(
      "invalid_payload",
      "The server returned a different item or version than the job names",
    );
  }
  return { item, version };
}

/** Error names of the studio runtime, matched by name because the module loads lazily. */
const STUDIO_FAILURES: Readonly<Record<string, { code: string; retryable: boolean }>> = {
  StoryboardValidationError: { code: "invalid_storyboard", retryable: false },
  RenderLintError: { code: "render_lint_failed", retryable: false },
  RenderVerificationError: { code: "render_verification_failed", retryable: false },
  CommandError: { code: "render_command_failed", retryable: false },
};

/**
 * Maps any failure to a job error. Messages are cut to a safe length; none of the errors mapped
 * here carries a key or a token.
 */
export function toJobFailure(error: unknown, fallbackCode = "production_failed"): unknown {
  if (error instanceof JobFailure) {
    return error;
  }
  if (error instanceof PlatformError) {
    return new JobFailure(
      `platform_${error.code}`.slice(0, 64),
      clip(error.message),
      error.retryable,
    );
  }
  if (error instanceof Error) {
    if (error.name === "TransferError") {
      const retryable = (error as Error & { retryable?: unknown }).retryable === true;
      return new JobFailure("transfer_failed", clip(error.message), retryable);
    }
    if (error.name === "ProviderError") {
      const retryable = (error as Error & { retryable?: unknown }).retryable === true;
      return new JobFailure("voice_provider_failed", clip(error.message), retryable);
    }
    const studio = STUDIO_FAILURES[error.name];
    if (studio !== undefined) {
      return new JobFailure(studio.code, clip(error.message), studio.retryable);
    }
    if (error.name === "AbortError") {
      return error;
    }
    return new JobFailure(fallbackCode, clip(error.message), false);
  }
  return error;
}

/**
 * Reports progress as `status` events at most once per 10% (and once per state change), so a long
 * render records about a dozen durable events.
 */
export class ProgressReporter {
  readonly #emit: (state: string, progress: number, message?: string) => void;
  #state = "";
  #decile = -1;

  constructor(emit: (state: string, progress: number, message?: string) => void) {
    this.#emit = emit;
  }

  report(state: string, fraction: number, message?: string): void {
    const progress = Math.min(Math.max(Number.isFinite(fraction) ? fraction : 0, 0), 1);
    const decile = Math.floor(progress * 10);
    if (state === this.#state && decile <= this.#decile) {
      return;
    }
    this.#state = state;
    this.#decile = decile;
    this.#emit(state, Math.round(progress * 1000) / 1000, message);
  }
}

function clip(text: string): string {
  return text.length <= 2_000 ? text : `${text.slice(0, 1_999)}…`;
}
