import { SLUG_MAX_LENGTH, SlugSchema, slugify } from "@loomcast/contracts";
import { formats, series } from "@loomcast/db";
import { and, eq, like, sql } from "drizzle-orm";
import type { Transaction } from "../../lib/db";
import { slugWithSuffix } from "../projects/service";

/** Longest collision suffix one lookup covers (`-99999`). */
const MAX_SUFFIX_LENGTH = 6;

/** Tables whose slugs are unique within a project. */
const TABLES = { format: formats, series } as const;

export type ProjectSlugKind = keyof typeof TABLES;

/** The slug a name turns into before collisions are considered, or `fallback`. */
export function nameSlug(name: string, fallback: string): string {
  const slug = slugify(name);
  return slug !== "" && SlugSchema.safeParse(slug).success ? slug : fallback;
}

/**
 * The first of `base`, `base-2`, `base-3`, … that no format (or series) of the project uses yet.
 * Must run inside the transaction that inserts the row: it holds a transaction-level advisory lock
 * on the project and slug prefix, so parallel creates of the same name queue up.
 */
export async function freeProjectSlug(
  tx: Transaction,
  kind: ProjectSlugKind,
  projectId: string,
  base: string,
): Promise<string> {
  const table = TABLES[kind];
  // Slugs hold only `[a-z0-9-]`, so the prefix needs no LIKE escaping.
  const prefix = base.slice(0, SLUG_MAX_LENGTH - MAX_SUFFIX_LENGTH).replace(/-+$/, "");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`loomcast:${kind}-slug:${projectId}:${prefix}`}))`,
  );
  const rows = await tx
    .select({ slug: table.slug })
    .from(table)
    .where(and(eq(table.projectId, projectId), like(table.slug, `${prefix}%`)));
  const taken = new Set(rows.map((row) => row.slug));
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = slugWithSuffix(base, n);
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
