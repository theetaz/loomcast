import { type ApiPostStatus, ApiPostStatusSchema } from "@loomcast/contracts";
import { type SQL, sql } from "drizzle-orm";
import type { Executor } from "../../lib/db";

// Which posts an API client sees, and the status of each, in one query. A client sees the posts
// it created (all of their targets) and, through its grants, every post on a granted channel
// (only the targets on granted channels). The status is computed from those targets here, so
// `GET /posts/:id` and the `status` filter of `GET /posts` always agree.

export interface PostViewer {
  tokenId: string;
  /** Every channel the client is granted, at any level. */
  channelIds: readonly string[];
}

export interface VisiblePostFilter {
  itemIds?: readonly string[];
  channelId?: string;
  status?: ApiPostStatus;
  from?: Date;
  to?: Date;
  /** Keyset cursor: posts created before this one, newest first. */
  before?: { createdAt: string; id: string };
  limit?: number;
}

export interface VisiblePost {
  itemId: string;
  status: ApiPostStatus;
  scheduledAt: Date | null;
  /** `created_at` as fixed-format UTC text with microseconds, for the cursor. */
  createdAt: string;
  /** Created by this client. */
  own: boolean;
}

interface Row extends Record<string, unknown> {
  item_id: string;
  status: string;
  scheduled_at: Date | string | null;
  created_at_text: string;
  own: boolean;
}

/** The posts `viewer` can see that match `filter`, newest first. */
export async function selectVisiblePosts(
  executor: Executor,
  viewer: PostViewer,
  filter: VisiblePostFilter = {},
): Promise<VisiblePost[]> {
  const granted = sql`${sql.param([...viewer.channelIds])}::uuid[]`;
  const conditions: SQL[] = [];
  if (filter.itemIds !== undefined) {
    if (filter.itemIds.length === 0) return [];
    conditions.push(sql`v.item_id = any(${sql.param([...filter.itemIds])}::uuid[])`);
  }
  if (filter.channelId !== undefined) {
    conditions.push(
      sql`(v.on_channel or (v.own and not v.finalized and v.targets @> ${sql.param(
        JSON.stringify([{ channelId: filter.channelId }]),
      )}::jsonb))`,
    );
  }
  if (filter.status !== undefined) {
    conditions.push(sql`v.status = ${filter.status}`);
  }
  if (filter.from !== undefined) {
    conditions.push(sql`v.scheduled_at >= ${filter.from.toISOString()}::timestamptz`);
  }
  if (filter.to !== undefined) {
    conditions.push(sql`v.scheduled_at < ${filter.to.toISOString()}::timestamptz`);
  }
  if (filter.before !== undefined) {
    conditions.push(
      sql`(v.created_at, v.item_id) < (${filter.before.createdAt}::timestamptz, ${filter.before.id}::uuid)`,
    );
  }
  const where = conditions.length === 0 ? sql`true` : sql.join(conditions, sql` and `);
  const channelId = filter.channelId ?? null;
  const limit = filter.limit === undefined ? sql`` : sql`limit ${filter.limit}`;

  const result = await executor.execute<Row>(sql`
    select v.item_id, v.status, v.scheduled_at, v.created_at_text, v.own
    from (
      select
        ci.id as item_id,
        ci.created_at,
        to_char(ci.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_text,
        ap.item_id is not null as own,
        ap.finalized_at is not null as finalized,
        ap.targets,
        agg.on_channel,
        case
          when ap.cancelled_at is not null then 'cancelled'
          when ap.item_id is not null and ap.finalized_at is null then 'awaiting_media'
          when agg.active = 0 then 'cancelled'
          when agg.planned > 0 then 'pending_approval'
          when agg.publishing > 0 then 'publishing'
          when agg.queued > 0 then 'scheduled'
          when agg.published = agg.active then 'published'
          when agg.published > 0 then 'partially_published'
          else 'failed'
        end as status,
        case
          when ap.item_id is not null and ap.finalized_at is null then ap.scheduled_at
          else coalesce(agg.first_open_at, agg.first_at)
        end as scheduled_at
      from content_items ci
      left join api_posts ap on ap.item_id = ci.id and ap.token_id = ${viewer.tokenId}::uuid
      cross join lateral (
        select
          count(*) as total,
          count(*) filter (where sp.status <> 'cancelled') as active,
          count(*) filter (where sp.status = 'planned') as planned,
          count(*) filter (where sp.status = 'queued') as queued,
          count(*) filter (where sp.status = 'publishing') as publishing,
          count(*) filter (where sp.status = 'published') as published,
          min(sp.scheduled_at) filter (where sp.status in ('planned', 'queued')) as first_open_at,
          min(sp.scheduled_at) filter (where sp.status <> 'cancelled') as first_at,
          coalesce(bool_or(sp.channel_id = ${channelId}::uuid), false) as on_channel
        from scheduled_posts sp
        where sp.item_id = ci.id and (ap.item_id is not null or sp.channel_id = any(${granted}))
      ) agg
      where ap.item_id is not null or agg.total > 0
    ) v
    where ${where}
    order by v.created_at desc, v.item_id desc
    ${limit}
  `);
  return result.rows.map((row) => ({
    itemId: row.item_id,
    status: ApiPostStatusSchema.parse(row.status),
    scheduledAt:
      row.scheduled_at === null
        ? null
        : row.scheduled_at instanceof Date
          ? row.scheduled_at
          : new Date(row.scheduled_at),
    createdAt: row.created_at_text,
    own: row.own,
  }));
}
