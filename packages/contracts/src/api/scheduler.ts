import { z } from "zod";
import { IdSchema, JsonObjectSchema, TimestampSchema } from "../common";
import { TaskStatusSchema } from "../enums";
import { ScheduledTaskKindSchema } from "../scheduler/tasks";
import { CursorPageQuerySchema } from "./common";

/** The last failure of a scheduled task. */
export const TaskErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(2_000),
  at: TimestampSchema,
});
export type TaskError = z.infer<typeof TaskErrorSchema>;

/** A scheduled task as admins see it. Payloads hold ids only, never secrets. */
export const ScheduledTaskSchema = z.object({
  id: IdSchema,
  kind: ScheduledTaskKindSchema,
  status: TaskStatusSchema,
  runAt: TimestampSchema,
  payload: JsonObjectSchema,
  /** Runs started so far. */
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  dedupeKey: z.string().nullable(),
  lastError: TaskErrorSchema.nullable(),
  lockedUntil: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

/** `GET /api/scheduler/tasks`: newest `runAt` first, cursor-paginated. Owner and admins only. */
export const ListScheduledTasksQuerySchema = CursorPageQuerySchema.extend({
  status: TaskStatusSchema.optional(),
  kind: ScheduledTaskKindSchema.optional(),
});
export type ListScheduledTasksQuery = z.infer<typeof ListScheduledTasksQuerySchema>;
