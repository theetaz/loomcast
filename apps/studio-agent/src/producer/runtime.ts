import type { JobEventData } from "@loomcast/contracts";
import { JobFailure } from "../handlers";
import type { CommandScope } from "../production/command-guard";
import type { SkillPackEntry } from "../production/skills";
import type { ProducerJobType, ProducerMcpAccess } from "./mcp";

/** The durable event kinds a producer runtime reports while a turn runs. */
export type ProducerEventKind =
  | "session"
  | "status"
  | "tool.activity"
  | "assistant.message"
  | "usage";

/** A durable event, recorded by the job handler through `ctx.emit`. */
export type ProducerEvent = {
  [K in ProducerEventKind]: { readonly kind: K; readonly data: JobEventData<K> };
}[ProducerEventKind];

export interface ProducerRunInput {
  /** The user's message for this turn. */
  readonly prompt: string;
  /** The producer session to continue. Without it a new session starts. */
  readonly resumeId?: string;
  /**
   * The project workspace. It must be the same directory on every turn of a session, because the
   * runtime keeps session transcripts per working directory.
   */
  readonly cwd: string;
  /** Aborting it stops the turn. */
  readonly signal: AbortSignal;
  /** The job the turn runs for; it picks the session's tools. Defaults to `producer.chat`. */
  readonly jobType?: ProducerJobType;
  /** The platform's MCP server for this job. Without it the session has no MCP servers. */
  readonly mcp?: ProducerMcpAccess;
  /** Appended to the preset system prompt. Defaults to the chat brief. */
  readonly brief?: string;
  /** Skills appended to the system prompt after the brief, in order. */
  readonly skills?: readonly SkillPackEntry[];
  /** Where a storyboard session's allow-listed commands may look. Without it Bash is denied. */
  readonly commandScope?: CommandScope;
  /** Receives durable events in order. */
  readonly onEvent: (event: ProducerEvent) => void;
  /** Receives streamed assistant text, already batched. */
  readonly onDelta: (text: string) => void;
}

export interface ProducerRunResult {
  /** The session the turn ran in; the next turn resumes it. */
  readonly sessionId: string;
  /** The assistant's final reply of the turn. */
  readonly finalText: string;
  readonly numTurns: number;
  readonly durationMs: number;
}

/**
 * Runs one producer turn. The job handler depends only on this interface, so the implementation
 * can be replaced (for example by a headless command-line fallback) without touching the handler.
 */
export interface ProducerRuntime {
  run(input: ProducerRunInput): Promise<ProducerRunResult>;
}

/** Error codes a producer runtime fails a turn with. */
export const PRODUCER_ERROR_CODES = {
  notAuthenticated: "producer_not_authenticated",
  account: "producer_account_unavailable",
  unavailable: "producer_unavailable",
  sessionNotFound: "producer_session_not_found",
  failed: "producer_failed",
} as const;

export type ProducerErrorCode = (typeof PRODUCER_ERROR_CODES)[keyof typeof PRODUCER_ERROR_CODES];

/** A failed producer turn. It fails the job with its code, message and retryability. */
export class ProducerError extends JobFailure {
  declare readonly code: ProducerErrorCode;

  constructor(code: ProducerErrorCode, message: string, retryable: boolean) {
    super(code, message, retryable);
  }
}

export function producerNotAuthenticated(): ProducerError {
  return new ProducerError(
    PRODUCER_ERROR_CODES.notAuthenticated,
    "Log in to the producer runtime on this Mac",
    false,
  );
}
