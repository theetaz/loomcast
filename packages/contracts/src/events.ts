import { z } from "zod";
import { AssetSchema } from "./api/assets";
import { ContentItemSchema, ContentVersionSummarySchema } from "./api/content";
import { MessageSchema } from "./api/conversations";
import { JobSummarySchema } from "./api/jobs";
import { KbEntrySchema } from "./api/kb";
import { ProjectSchema } from "./api/projects";
import { ReviewSchema } from "./api/reviews";
import { SkillVersionSummarySchema } from "./api/skills";
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
  /**
   * Progress of a running job, such as a tool use. `kind` names the activity, e.g. the tool.
   * `progress` (0 to 1) is set when the job reports how far it is, such as a render.
   */
  liveEvent(
    "job.activity",
    z.object({
      jobId: IdSchema,
      kind: z.string(),
      summary: z.string(),
      progress: z.number().min(0).max(1).optional(),
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
  /** Knowledge-base writes from any source: the web app, MCP, a producer session or the hook. */
  liveEvent("kb.entry.created", z.object({ entry: KbEntrySchema })),
  liveEvent("kb.entry.updated", z.object({ entry: KbEntrySchema })),
  liveEvent("kb.entry.deleted", z.object({ entryId: IdSchema, projectId: IdSchema })),
  /** Content items: creation, and any change of state, title, target, autopilot or last error. */
  liveEvent("content.item.created", z.object({ item: ContentItemSchema })),
  liveEvent("content.item.updated", z.object({ item: ContentItemSchema })),
  /** A new version of an item, from a job result, an MCP submission or an edit. */
  liveEvent(
    "content.version.created",
    z.object({ projectId: IdSchema, version: ContentVersionSummarySchema }),
  ),
  /** An asset was created, finalized or failed verification. */
  liveEvent("asset.updated", z.object({ asset: AssetSchema })),
  liveEvent("review.created", z.object({ projectId: IdSchema, review: ReviewSchema })),
  /** A new skill version; skills are global, not tied to a project. */
  liveEvent("skill.published", z.object({ skill: SkillVersionSummarySchema })),
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
