import { z } from "zod";
import { IdSchema, JsonObjectSchema, TimestampSchema } from "../common";
import { JobTypeSchema } from "../enums";
import { bridgeMessage } from "./envelope";

const durationMs = z.number().int().positive();

/** Limits the server enforces, repeated to the agent in `hello.ok`. */
export const BridgeLimitsSchema = z.object({
  maxPayloadBytes: z.number().int().positive(),
  maxStreamTextLength: z.number().int().positive(),
});
export type BridgeLimits = z.infer<typeof BridgeLimitsSchema>;

/** Answer to `hello`. `heartbeatMs` is the server's ping interval. */
export const HelloOkSchema = bridgeMessage(
  "hello.ok",
  z.object({
    deviceId: IdSchema,
    serverTime: TimestampSchema,
    heartbeatMs: durationMs,
    leaseMs: durationMs,
    limits: BridgeLimitsSchema,
  }),
);

/**
 * The job handed to the agent. `payload` is checked by the agent against the job type's registry
 * schema, so a bad payload is answered with `job.reject` rather than a closed socket.
 */
export const AssignedJobSchema = z.object({
  id: IdSchema,
  type: JobTypeSchema,
  attempt: z.number().int().min(1),
  payload: JsonObjectSchema,
  projectId: IdSchema,
  conversationId: IdSchema.optional(),
});
export type AssignedJob = z.infer<typeof AssignedJobSchema>;

export const JobAssignSchema = bridgeMessage(
  "job.assign",
  z.object({
    job: AssignedJobSchema,
    leaseMs: durationMs,
  }),
);

export const JobCancelSchema = bridgeMessage("job.cancel", z.object({ jobId: IdSchema }));

/** Cumulative: every durable event of `jobId` up to and including `upToSeq` is stored. */
export const AckSchema = bridgeMessage(
  "ack",
  z.object({
    jobId: IdSchema,
    upToSeq: z.number().int().min(0),
  }),
);

export const BridgeErrorSchema = bridgeMessage(
  "error",
  z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(2_000),
  }),
);

export const ServerToAgentSchema = z.discriminatedUnion("type", [
  HelloOkSchema,
  JobAssignSchema,
  JobCancelSchema,
  AckSchema,
  BridgeErrorSchema,
]);
export type ServerToAgent = z.infer<typeof ServerToAgentSchema>;
export type ServerToAgentType = ServerToAgent["type"];
export type ServerMessageOf<T extends ServerToAgentType> = Extract<ServerToAgent, { type: T }>;
