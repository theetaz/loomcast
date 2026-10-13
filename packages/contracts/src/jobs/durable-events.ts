import { z } from "zod";
import { IdSchema, MAX_ASSISTANT_TEXT_LENGTH } from "../common";

/**
 * Kinds of durable job events. They are written to the agent's outbox, acknowledged by the server
 * and stored in `job_events`, so none is lost across reconnects.
 */
export const JOB_EVENT_KINDS = [
  "status",
  "session",
  "tool.activity",
  "assistant.message",
  "usage",
  "log",
] as const;
export const JobEventKindSchema = z.enum(JOB_EVENT_KINDS);
export type JobEventKind = (typeof JOB_EVENT_KINDS)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const count = z.number().int().min(0);

/** The `data` schema of each durable event kind. */
export const JOB_EVENT_DATA = {
  /**
   * A coarse progress step of the handler, such as `starting` or `rendering`. `progress` is the
   * share done, from 0 to 1, when the handler can tell (renders report every 10%).
   */
  status: z.object({
    state: z.string().min(1).max(64),
    message: z.string().max(1_000).optional(),
    progress: z.number().min(0).max(1).optional(),
  }),
  /** The producer session the job runs in, sent as soon as it is known. */
  session: z.object({
    sessionId: z.string().min(1).max(200),
  }),
  /** One tool use: the tool name and a short, redacted summary for the UI. */
  "tool.activity": z.object({
    tool: z.string().min(1).max(100),
    summary: z.string().max(500),
  }),
  /** A complete assistant reply. It carries the full text even if stream deltas were dropped. */
  "assistant.message": z.object({
    text: z.string().max(MAX_ASSISTANT_TEXT_LENGTH),
  }),
  /** Token and cost accounting reported by the producer runtime. */
  usage: z.object({
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    cacheReadTokens: count.optional(),
    cacheCreationTokens: count.optional(),
    costUsd: z.number().min(0).optional(),
  }),
  log: z.object({
    level: z.enum(LOG_LEVELS),
    message: z.string().max(2_000),
  }),
} as const satisfies Record<JobEventKind, z.ZodType>;

export type JobEventData<K extends JobEventKind> = z.infer<(typeof JOB_EVENT_DATA)[K]>;

/** Sequence numbers start at 1 for each job and increase by one per durable event. */
export const JobEventSeqSchema = z.number().int().min(1);

function jobEvent<const K extends JobEventKind>(kind: K) {
  return z.object({
    jobId: IdSchema,
    seq: JobEventSeqSchema,
    kind: z.literal(kind),
    data: JOB_EVENT_DATA[kind],
  });
}

/** A durable job event, discriminated by `kind`. */
export const JobEventSchema = z.discriminatedUnion("kind", [
  jobEvent("status"),
  jobEvent("session"),
  jobEvent("tool.activity"),
  jobEvent("assistant.message"),
  jobEvent("usage"),
  jobEvent("log"),
]);
export type JobEvent = z.infer<typeof JobEventSchema>;
