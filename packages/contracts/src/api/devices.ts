import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { DeviceTokenSecretSchema } from "./tokens";

/** Pairing-code characters: digits and capitals without the look-alikes 0, 1, I and O. */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** `XXXX-XXXX` over `PAIRING_CODE_ALPHABET`. */
export const PAIRING_CODE_RE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** Accepts surrounding spaces and lowercase input, as typed on the command line. */
export const PairingCodeValueSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PAIRING_CODE_RE, { message: "Expected a code like ABCD-EFGH" });

export const DEVICE_NAME_MAX_LENGTH = 100;

export const DeviceSchema = z.object({
  id: IdSchema,
  name: z.string(),
  platform: z.string(),
  agentVersion: z.string().nullable(),
  /** True while the device has a live bridge connection. */
  online: z.boolean(),
  lastSeenAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;

/** Response of `POST /api/devices/pairing-codes`. The code is single use. */
export const PairingCodeSchema = z.object({
  code: PairingCodeValueSchema,
  expiresAt: TimestampSchema,
});
export type PairingCode = z.infer<typeof PairingCodeSchema>;

/** Sent by `studio-agent pair` to `POST /api/bridge/pair`. */
export const PairRequestSchema = z.object({
  code: PairingCodeValueSchema,
  name: z.string().trim().min(1).max(DEVICE_NAME_MAX_LENGTH),
  platform: z.string().min(1).max(64),
  agentVersion: z.string().min(1).max(64),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

/** The device token is returned once; the agent stores it and the server keeps only its hash. */
export const PairResponseSchema = z.object({
  deviceId: IdSchema,
  token: DeviceTokenSecretSchema,
});
export type PairResponse = z.infer<typeof PairResponseSchema>;
