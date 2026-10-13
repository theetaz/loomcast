import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  contentItems,
  contentVersions,
  formats,
  formatVersions,
  skills,
  skillVersions,
} from "../schema";

// Version numbering. Each helper locks the parent row with `SELECT ... FOR UPDATE` and then reads
// the highest number in a second statement, so writers of the same parent queue up and each sees
// the versions committed before it. Call them inside a transaction (the lock lasts until it ends)
// at the default READ COMMITTED level: under REPEATABLE READ the second statement would reuse the
// snapshot taken before the lock was granted. The unique `(parent, number)` indexes stay the last
// line of defence.

/** Anything that can run a raw query: a transaction, or the database (which holds no lock). */
export type VersionExecutor = Pick<Database, "execute">;

async function nextNumber(tx: VersionExecutor, lock: SQL, next: SQL): Promise<number | null> {
  const locked = await tx.execute(lock);
  if (locked.rows.length === 0) return null;
  const result = await tx.execute<{ next: number }>(next);
  return result.rows[0]?.next ?? 1;
}

/**
 * Locks the content item and returns the number its next version gets: one more than the highest
 * so far. Returns null when the item does not exist.
 */
export function nextVersionNo(tx: VersionExecutor, itemId: string): Promise<number | null> {
  return nextNumber(
    tx,
    sql`select 1 from ${contentItems} where ${contentItems.id} = ${itemId} for update`,
    sql`select coalesce(max(${contentVersions.versionNo}), 0)::int + 1 as next
        from ${contentVersions} where ${contentVersions.itemId} = ${itemId}`,
  );
}

/**
 * Locks the format and returns the number its next version gets. Returns null when the format
 * does not exist.
 */
export function nextFormatVersionNo(tx: VersionExecutor, formatId: string): Promise<number | null> {
  return nextNumber(
    tx,
    sql`select 1 from ${formats} where ${formats.id} = ${formatId} for update`,
    sql`select coalesce(max(${formatVersions.versionNo}), 0)::int + 1 as next
        from ${formatVersions} where ${formatVersions.formatId} = ${formatId}`,
  );
}

/**
 * Locks the skill and returns the number its next published version gets. Returns null when the
 * skill does not exist yet; its first version is 1.
 */
export function nextSkillVersion(tx: VersionExecutor, skillId: string): Promise<number | null> {
  return nextNumber(
    tx,
    sql`select 1 from ${skills} where ${skills.id} = ${skillId} for update`,
    sql`select coalesce(max(${skillVersions.version}), 0)::int + 1 as next
        from ${skillVersions} where ${skillVersions.skillId} = ${skillId}`,
  );
}
