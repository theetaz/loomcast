import { z } from "zod";
import { JobErrorSchema } from "../api/jobs";
import { IdSchema, JsonObjectSchema } from "../common";
import { JobTypeSchema } from "../enums";
import { CreditsSchema } from "../jobs/concurrency";
import { JobEventSchema } from "../jobs/durable-events";
import { BRIDGE_LIMITS, PROTOCOL_VERSION } from "./constants";
import { bridgeMessage } from "./envelope";

/** A job the agent was running when it lost the connection, and the last event the server acked. */
export const ResumeEntrySchema = z.object({
  jobId: IdSchema,
  lastAckedSeq: z.number().int().min(0),
});
export type ResumeEntry = z.infer<typeof ResumeEntrySchema>;

/** First message on every connection. */
export const HelloSchema = bridgeMessage(
  "hello",
  z.object({
    protocol: z.literal(PROTOCOL_VERSION),
    agentVersion: z.string().min(1).max(64),
    platform: z.string().min(1).max(64),
    jobTypes: z.array(JobTypeSchema).max(BRIDGE_LIMITS.maxJobTypes),
    credits: CreditsSchema,
    resume: z.array(ResumeEntrySchema).max(BRIDGE_LIMITS.maxJobsPerMessage),
  }),
);

export const JobAcceptSchema = bridgeMessage("job.accept", z.object({ jobId: IdSchema }));

export const JobRejectSchema = bridgeMessage(
  "job.reject",
  z.object({
    jobId: IdSchema,
    reason: z.string().max(500).optional(),
  }),
);

/** A durable event. The server stores it once per `(jobId, seq)` and acks cumulatively. */
export const JobEventMessageSchema = bridgeMessage("job.event", JobEventSchema);

/** Ephemeral streaming text. Never acked or stored, and dropped under backpressure. */
export const JobStreamSchema = bridgeMessage(
  "job.stream",
  z.object({
    jobId: IdSchema,
    kind: z.literal("assistant.delta"),
    text: z.string().min(1).max(BRIDGE_LIMITS.maxStreamTextLength),
  }),
);

/** Sent while jobs run; extends their leases. */
export const JobHeartbeatSchema = bridgeMessage(
  "job.heartbeat",
  z.object({
    jobIds: z.array(IdSchema).max(BRIDGE_LIMITS.maxJobsPerMessage),
  }),
);

/** `result` is validated by the server against the job type's registry result schema. */
export const JobCompleteSchema = bridgeMessage(
  "job.complete",
  z.object({
    jobId: IdSchema,
    result: JsonObjectSchema,
  }),
);

export const JobFailSchema = bridgeMessage(
  "job.fail",
  z.object({
    jobId: IdSchema,
    error: JobErrorSchema,
  }),
);

/** Free slots per concurrency class, sent whenever they change. */
export const CreditsMessageSchema = bridgeMessage("credits", CreditsSchema);

export const AgentToServerSchema = z.discriminatedUnion("type", [
  HelloSchema,
  JobAcceptSchema,
  JobRejectSchema,
  JobEventMessageSchema,
  JobStreamSchema,
  JobHeartbeatSchema,
  JobCompleteSchema,
  JobFailSchema,
  CreditsMessageSchema,
]);
export type AgentToServer = z.infer<typeof AgentToServerSchema>;
export type AgentToServerType = AgentToServer["type"];
export type AgentMessageOf<T extends AgentToServerType> = Extract<AgentToServer, { type: T }>;
