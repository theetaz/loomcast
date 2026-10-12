import { z } from "zod";

/** Primary keys of every M1 table except `job_events` and `audit_log`. */
export const IdSchema = z.uuid();
export type Id = z.infer<typeof IdSchema>;

/** Timestamps travel as ISO 8601 strings, for example `Date.prototype.toISOString()` output. */
export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Plain JSON object, used where the shape is decided by a registry rather than the wire format. */
export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

/** Longest user chat message, in UTF-16 code units. */
export const MAX_MESSAGE_TEXT_LENGTH = 20_000;

/** Longest assistant text in one event or job result; keeps bridge frames well under 1 MiB. */
export const MAX_ASSISTANT_TEXT_LENGTH = 100_000;

/** Chat text: at most 20,000 characters and not only whitespace. */
export const MessageTextSchema = z
  .string()
  .max(MAX_MESSAGE_TEXT_LENGTH)
  .refine((text) => text.trim().length > 0, { message: "Message text must not be empty" });
