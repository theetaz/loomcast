import type { JsonObject } from "@loomcast/contracts";
import { bigserial, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt } from "./columns";
import { actorKind } from "./enums";

/**
 * Append-only record of security-relevant actions: sign-ins, token, device, user and project
 * lifecycle. Ids are stored as text without foreign keys, so entries outlive what they describe.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorKind: actorKind("actor_kind").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    data: jsonb("data").$type<JsonObject>(),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_created_at_idx").on(t.createdAt.desc())],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
