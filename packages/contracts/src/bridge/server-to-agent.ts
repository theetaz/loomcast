import { z } from "zod";
import { JobTokenSecretSchema } from "../api/tokens";
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

/**
 * An absolute path on the server, such as `/mcp`. The agent resolves it against its own
 * `serverUrl`, so credentials are only ever sent back to the server that issued them: a scheme, a
 * host (`//host`) or a backslash is rejected.
 */
export const ServerPathSchema = z
  .string()
  .max(200)
  .regex(/^\/(?!\/)[A-Za-z0-9._~/-]*$/, { message: "Expected a path such as /mcp" });

/**
 * Credentials for one job, sent only when the job type's `mcpAccess` is not `none`.
 *
 * `mcp.token` is a job token (`lc_job_…`) scoped to the job's project with the scopes of its
 * `mcpAccess`, and it expires at `expiresAt` or when the job ends, whichever is first. The producer
 * session uses it instead of the device token, which it never sees.
 *
 * Credentials are never persisted: the agent keeps them in memory for the running job only and
 * never writes them to its config, outbox, journal or logs. A job that is assigned again gets
 * fresh credentials in the new `job.assign`.
 */
export const JobCredentialsSchema = z.object({
  mcp: z.object({
    endpoint: ServerPathSchema,
    token: JobTokenSecretSchema,
    expiresAt: TimestampSchema,
  }),
});
export type JobCredentials = z.infer<typeof JobCredentialsSchema>;

/** `credentials` is optional, so frames from servers that send none still parse. */
export const JobAssignSchema = bridgeMessage(
  "job.assign",
  z.object({
    job: AssignedJobSchema,
    leaseMs: durationMs,
    credentials: JobCredentialsSchema.optional(),
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
