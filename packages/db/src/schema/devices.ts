import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { apiTokens } from "./auth";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { users } from "./users";

/** A paired studio agent. Each device owns exactly one `device` token. */
export const devices = pgTable(
  "devices",
  {
    id: uuidPrimaryKey(),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    agentVersion: text("agent_version"),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => apiTokens.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    lastSeenAt: timestamptz("last_seen_at"),
    revokedAt: timestamptz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("devices_token_id_uq").on(t.tokenId)],
);

/**
 * Single-use pairing codes (10 minutes). Only the hash of the code is stored. `usedAt` and
 * `deviceId` are set together when a studio agent redeems the code.
 */
export const pairingCodes = pgTable(
  "pairing_codes",
  {
    id: uuidPrimaryKey(),
    codeHash: text("code_hash").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamptz("expires_at").notNull(),
    usedAt: timestamptz("used_at"),
    deviceId: uuid("device_id").references(() => devices.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("pairing_codes_code_hash_uq").on(t.codeHash)],
);

export type DeviceRow = typeof devices.$inferSelect;
export type NewDeviceRow = typeof devices.$inferInsert;
export type PairingCodeRow = typeof pairingCodes.$inferSelect;
export type NewPairingCodeRow = typeof pairingCodes.$inferInsert;
