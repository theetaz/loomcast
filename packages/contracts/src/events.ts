import { z } from "zod";
import { MessageSchema } from "./api/conversations";
import { JobSummarySchema } from "./api/jobs";
import { ProjectSchema } from "./api/projects";
import { IdSchema, TimestampSchema } from "./common";

/** Server-sent events endpoint. Each event's `data` is one JSON-encoded `LiveEvent`. */
export const LIVE_STREAM_PATH = "/api/stream";

function liveEvent<const T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ type: z.literal(type), payload });
}

export const LiveEventSchema = z.discriminatedUnion("type", [
  /** A stored message: the user's post, or a complete assistant reply. */
  liveEvent("conversation.message.created", z.object({ message: MessageSchema })),
  /** Streaming assistant text. Ephemeral: replaced by the `created` event of the full reply. */
  liveEvent(
    "conversation.message.delta",
    z.object({
      conversationId: IdSchema,
      jobId: IdSchema,
      text: z.string(),
    }),
  ),
  /** Any change of a job's status. */
  liveEvent("job.updated", z.object({ job: JobSummarySchema })),
  /** Progress of a running job, such as a tool use. `kind` names the activity, e.g. the tool. */
  liveEvent(
    "job.activity",
    z.object({
      jobId: IdSchema,
      kind: z.string(),
      summary: z.string(),
    }),
  ),
  liveEvent(
    "device.status",
    z.object({
      deviceId: IdSchema,
      online: z.boolean(),
      lastSeenAt: TimestampSchema.nullable(),
    }),
  ),
  liveEvent("project.created", z.object({ project: ProjectSchema })),
  liveEvent("project.updated", z.object({ project: ProjectSchema })),
  /** The client missed events it cannot replay and should refetch its data. */
  liveEvent("resync", z.object({})),
]);
export type LiveEvent = z.infer<typeof LiveEventSchema>;
export type LiveEventType = LiveEvent["type"];
export type LiveEventOf<T extends LiveEventType> = Extract<LiveEvent, { type: T }>;

/**
 * Parses the `data` of one server-sent event. Returns `null` for invalid JSON or an unknown event,
 * so an older client ignores event types it does not know yet.
 */
export function parseLiveEvent(data: string): LiveEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  const result = LiveEventSchema.safeParse(value);
  return result.success ? result.data : null;
}
