import { z } from "zod";
import { JsonObjectSchema, TimestampSchema } from "../common";
import { ULID_RE } from "../util/ulid";
import { PROTOCOL_VERSION } from "./constants";

export const MessageIdSchema = z.string().regex(ULID_RE, { message: "Expected a ULID" });

/**
 * Every bridge frame is one JSON text frame with this envelope. `ref` is the id of the message
 * being answered, when there is one.
 */
export const EnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: MessageIdSchema,
  type: z.string().min(1).max(64),
  ts: TimestampSchema,
  ref: MessageIdSchema.optional(),
  payload: JsonObjectSchema,
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** The envelope schema of one message type with its payload schema. */
export function bridgeMessage<const T extends string, P extends z.ZodType>(type: T, payload: P) {
  return EnvelopeSchema.extend({
    type: z.literal(type),
    payload,
  });
}
