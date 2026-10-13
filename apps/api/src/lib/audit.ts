import type { ActorKind, JsonObject } from "@loomcast/contracts";
import { auditLog } from "@loomcast/db";
import type { Executor } from "./db";

export interface AuditEntry {
  actorKind: ActorKind;
  actorId?: string | null;
  /** Dotted verb, for example `auth.login.succeeded` or `token.revoked`. */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Never put secrets here: no passwords, tokens or codes. */
  data?: JsonObject | null;
  ip?: string | null;
}

/** Appends one row to `audit_log`. Pass the transaction when the audited change runs in one. */
export async function audit(executor: Executor, entry: AuditEntry): Promise<void> {
  await executor.insert(auditLog).values({
    actorKind: entry.actorKind,
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    data: entry.data ?? null,
    ip: entry.ip ?? null,
  });
}
