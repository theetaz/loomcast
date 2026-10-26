import {
  KB_SEARCH_DEFAULT_LIMIT,
  KB_SEARCH_MAX_LIMIT,
  KB_SNIPPET_MATCH_END,
  KB_SNIPPET_MATCH_START,
  type KbEntryKind,
  type KbSearchHit,
} from "@loomcast/contracts";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../client";

export interface KbSearchOptions {
  /** The user's query in web-search syntax: `"exact phrase"`, `-exclude`, `or`. */
  q: string;
  /** Limits the search to one workspace. Without it every workspace is searched. */
  workspaceId?: string;
  /** Limits the search to these entry kinds. An empty list matches nothing. */
  kinds?: readonly KbEntryKind[];
  /** Most hits returned, 1 to `KB_SEARCH_MAX_LIMIT`. Defaults to `KB_SEARCH_DEFAULT_LIMIT`. */
  limit?: number;
}

/** Anything that can run a raw query: the database or a transaction. */
export type KbSearchExecutor = Pick<Database, "execute">;

/** Length of the snippet used when the body has no highlighted match. */
export const KB_SNIPPET_FALLBACK_LENGTH = 160;

/** Snippets are cut to this length, well under the contract's 2 000. */
const SNIPPET_MAX_LENGTH = 1_000;

const HEADLINE_OPTIONS = [
  `StartSel=${KB_SNIPPET_MATCH_START}`,
  `StopSel=${KB_SNIPPET_MATCH_END}`,
  "MaxFragments=2",
  "MaxWords=18",
  "MinWords=6",
].join(",");

/** Escapes `\`, `%` and `_` so the text matches literally in a `LIKE` pattern. */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

interface KbSearchRow extends Record<string, unknown> {
  entryId: string;
  workspaceId: string;
  kind: KbEntryKind;
  title: string;
  snippet: string;
  score: number;
}

/**
 * Ranked full-text search over knowledge-base entries that are not deleted.
 *
 * An entry matches when its search vector matches `websearch_to_tsquery(q)`, when its title is
 * trigram-similar to `q` (whole title `%`, or a word of it `<%`, which catches typos such as
 * "brainstrom"), or when its title starts with `q`. The score adds:
 *
 * - `ts_rank_cd(search, query, 32)`: title words weigh more than tags, body and extra text;
 * - `0.6 *` the better of `similarity(title, q)` and `word_similarity(q, title)`;
 * - `0.3` when the title starts with `q`.
 *
 * Ties are broken by the most recently updated entry. The snippet is `ts_headline` over the body
 * with matches between `KB_SNIPPET_MATCH_START` and `KB_SNIPPET_MATCH_END`, or the start of the
 * body when it has no match. Trigram thresholds are the `pg_trgm` defaults (0.3 and 0.6).
 */
export async function kbSearch(
  db: KbSearchExecutor,
  options: KbSearchOptions,
): Promise<KbSearchHit[]> {
  const q = options.q.trim();
  if (q === "" || options.kinds?.length === 0) {
    return [];
  }
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? KB_SEARCH_DEFAULT_LIMIT), 1),
    KB_SEARCH_MAX_LIMIT,
  );
  const prefix = `${escapeLikePattern(q)}%`;

  const filters: SQL[] = [sql`kb_entries.deleted_at is null`];
  if (options.workspaceId !== undefined) {
    filters.push(sql`kb_entries.workspace_id = ${options.workspaceId}`);
  }
  if (options.kinds !== undefined) {
    const kinds = sql.join(
      options.kinds.map((kind) => sql`${kind}`),
      sql`, `,
    );
    filters.push(sql`kb_entries.kind in (${kinds})`);
  }

  // Ranks every candidate, then builds snippets for the returned rows only: ts_headline re-parses
  // the body and is the expensive part.
  const result = await db.execute<KbSearchRow>(sql`
    with query as (
      select websearch_to_tsquery('english'::regconfig, ${q}) as wq
    ),
    ranked as (
      select
        kb_entries.id,
        kb_entries.workspace_id,
        kb_entries.kind,
        kb_entries.title,
        kb_entries.body_md,
        kb_entries.updated_at,
        kb_entries.search @@ query.wq as text_match,
        (
          ts_rank_cd(kb_entries.search, query.wq, 32)
          + 0.6 * greatest(similarity(kb_entries.title, ${q}), word_similarity(${q}, kb_entries.title))
          + case when kb_entries.title ilike ${prefix} then 0.3 else 0 end
        )::float8 as score
      from kb_entries, query
      where ${sql.join(filters, sql` and `)}
        and (
          kb_entries.search @@ query.wq
          or kb_entries.title % ${q}
          or ${q} <% kb_entries.title
          or kb_entries.title ilike ${prefix}
        )
      order by score desc, kb_entries.updated_at desc, kb_entries.id
      limit ${limit}
    ),
    bodies as (
      select
        ranked.*,
        translate(ranked.body_md, ${KB_SNIPPET_MATCH_START + KB_SNIPPET_MATCH_END}, '') as body
      from ranked
    ),
    snippets as (
      select
        bodies.*,
        case when bodies.text_match then
          ts_headline('english'::regconfig, bodies.body, query.wq, ${HEADLINE_OPTIONS})
        end as headline,
        left(
          btrim(regexp_replace(left(bodies.body, ${4 * KB_SNIPPET_FALLBACK_LENGTH}), '[[:space:]]+', ' ', 'g')),
          ${KB_SNIPPET_FALLBACK_LENGTH}
        ) as fallback
      from bodies, query
    )
    select
      snippets.id as "entryId",
      snippets.workspace_id as "workspaceId",
      snippets.kind,
      snippets.title,
      left(
        case
          when strpos(snippets.headline, ${KB_SNIPPET_MATCH_START}) > 0 then snippets.headline
          else snippets.fallback
        end,
        ${SNIPPET_MAX_LENGTH}
      ) as snippet,
      snippets.score
    from snippets
    order by snippets.score desc, snippets.updated_at desc, snippets.id
  `);

  return result.rows.map((row) => ({
    entryId: row.entryId,
    workspaceId: row.workspaceId,
    kind: row.kind,
    title: row.title,
    snippet: row.snippet,
    score: Number(row.score),
  }));
}

/**
 * The hidden search text of a reference entry: author, why it was liked and the transcript, so a
 * search finds references by what was said in them. Store it in `kb_entries.search_extra`.
 */
export function referenceSearchExtra(reference: {
  author?: string | null;
  likedReason?: string | null;
  transcript?: string | null;
}): string {
  return [reference.author, reference.likedReason, reference.transcript]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join("\n");
}
