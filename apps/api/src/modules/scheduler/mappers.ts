import type { ScheduledTask, ScheduledTaskKind } from "@loomcast/contracts";
import type { ScheduledTaskRow } from "@loomcast/db";

/**
 * A task as admins see it. Lease holders stay internal; payloads hold ids only, as every enqueue
 * validates them against the registry.
 */
export function toScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    kind: row.kind as ScheduledTaskKind,
    status: row.status,
    runAt: row.runAt.toISOString(),
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    dedupeKey: row.dedupeKey,
    lastError: row.lastError ?? null,
    lockedUntil: row.lockedUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
