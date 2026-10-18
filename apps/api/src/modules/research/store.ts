import {
  RESEARCH_LIMITS,
  RESEARCH_MEDIAN_VIDEOS,
  type ResearchAccountSource,
  type ResearchPlatform,
  type ResearchVideoSource,
  researchExternalIdFromUrl,
} from "@loomcast/contracts";
import {
  type ResearchAccountRow,
  type ResearchVideoRow,
  researchAccounts,
  researchVideoSnapshots,
  researchVideos,
} from "@loomcast/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Executor } from "../../lib/db";
import type { DiscoveredMedia } from "../../lib/meta-graph";
import { isVideo, publicVideoLink } from "../competitors/discovery";
import { median } from "./math";

// Writes to the research tables. Every function takes the database or an open transaction, so a
// competitor scan stores its videos in the transaction that records the scan. After any change to
// an account's videos, call `recomputeAccounts` for it: it derives the median and outlier scores.

/** An account to create or update. Undefined fields keep what is stored. */
export interface AccountWrite {
  platform: ResearchPlatform;
  /** Already normalised with `normalizeResearchHandle`. */
  handle: string;
  source: ResearchAccountSource;
  displayName?: string | null | undefined;
  followers?: number | null | undefined;
  notes?: string | null | undefined;
  competitorId?: string | null | undefined;
  lastSyncedAt?: Date | null | undefined;
}

/**
 * Creates the account or updates it. Given values replace stored ones and missing ones are kept;
 * `tracked` wins over `discovered`, so tracking a discovered account promotes it.
 */
export async function upsertAccount(
  executor: Executor,
  workspaceId: string,
  input: AccountWrite,
): Promise<ResearchAccountRow> {
  const [row] = await executor
    .insert(researchAccounts)
    .values({
      workspaceId,
      platform: input.platform,
      handle: input.handle,
      source: input.source,
      displayName: input.displayName ?? null,
      followers: input.followers ?? null,
      notes: input.notes ?? null,
      competitorId: input.competitorId ?? null,
      lastSyncedAt: input.lastSyncedAt ?? null,
    })
    .onConflictDoUpdate({
      target: [researchAccounts.workspaceId, researchAccounts.platform, researchAccounts.handle],
      set: {
        displayName: sql`coalesce(excluded.display_name, ${researchAccounts.displayName})`,
        followers: sql`coalesce(excluded.followers, ${researchAccounts.followers})`,
        notes: sql`coalesce(excluded.notes, ${researchAccounts.notes})`,
        competitorId: sql`coalesce(excluded.competitor_id, ${researchAccounts.competitorId})`,
        lastSyncedAt: sql`coalesce(excluded.last_synced_at, ${researchAccounts.lastSyncedAt})`,
        source: sql`case when excluded.source = 'tracked' then 'tracked' else ${researchAccounts.source} end`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (row === undefined) {
    throw new Error("research account was not stored");
  }
  return row;
}

/** A video to create or update. Undefined fields keep what is stored. */
export interface VideoWrite {
  externalId: string;
  source: ResearchVideoSource;
  url?: string | null | undefined;
  caption?: string | null | undefined;
  postedAt?: Date | null | undefined;
  durationS?: number | null | undefined;
  views?: number | null | undefined;
  likes?: number | null | undefined;
  comments?: number | null | undefined;
  shares?: number | null | undefined;
  /** Already normalised with `normalizeTopic`. */
  topic?: string | null | undefined;
  tags?: string[] | undefined;
  hook?: string | null | undefined;
  format?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface StoredVideo {
  id: string;
  externalId: string;
  created: boolean;
  /** Whether a snapshot of its counts was written. */
  snapshot: boolean;
}

const METRICS = ["views", "likes", "comments", "shares"] as const;

type Metrics = Pick<ResearchVideoRow, (typeof METRICS)[number]>;

function pick<T>(given: T | undefined, stored: T): T {
  return given === undefined ? stored : given;
}

/** The stored row's fields with the given ones laid over them. */
function merged(existing: ResearchVideoRow | undefined, video: VideoWrite) {
  return {
    url: pick(video.url, existing?.url ?? null),
    caption: pick(video.caption, existing?.caption ?? null),
    postedAt: pick(video.postedAt, existing?.postedAt ?? null),
    durationS: pick(video.durationS, existing?.durationS ?? null),
    views: pick(video.views, existing?.views ?? null),
    likes: pick(video.likes, existing?.likes ?? null),
    comments: pick(video.comments, existing?.comments ?? null),
    shares: pick(video.shares, existing?.shares ?? null),
    topic: pick(video.topic, existing?.topic ?? null),
    tags: pick(video.tags, existing?.tags ?? []),
    hook: pick(video.hook, existing?.hook ?? null),
    format: pick(video.format, existing?.format ?? null),
    notes: pick(video.notes, existing?.notes ?? null),
  };
}

function metricsChanged(before: Metrics | undefined, after: Metrics): boolean {
  if (before === undefined) {
    return METRICS.some((key) => after[key] !== null);
  }
  return METRICS.some((key) => before[key] !== after[key]);
}

/**
 * Creates or updates `videos` of one account, keyed by `(workspace, platform, externalId)`, and
 * writes a snapshot for each video whose counts changed (or a new video with any count). A video
 * already stored keeps its account, first source and first-seen time. Call `recomputeAccounts`
 * afterwards.
 */
export async function upsertVideos(
  executor: Executor,
  account: Pick<ResearchAccountRow, "id" | "workspaceId" | "platform">,
  videos: readonly VideoWrite[],
): Promise<StoredVideo[]> {
  if (videos.length === 0) return [];
  const externalIds = [...new Set(videos.map((video) => video.externalId))];
  const rows = await executor
    .select()
    .from(researchVideos)
    .where(
      and(
        eq(researchVideos.workspaceId, account.workspaceId),
        eq(researchVideos.platform, account.platform),
        inArray(researchVideos.externalId, externalIds),
      ),
    )
    .for("update");
  const known = new Map(rows.map((row) => [row.externalId, row]));
  const stored: StoredVideo[] = [];

  for (const video of videos) {
    const existing = known.get(video.externalId);
    const values = merged(existing, video);
    const [row] = await executor
      .insert(researchVideos)
      .values({
        workspaceId: account.workspaceId,
        accountId: account.id,
        platform: account.platform,
        externalId: video.externalId,
        source: video.source,
        ...values,
      })
      .onConflictDoUpdate({
        target: [researchVideos.workspaceId, researchVideos.platform, researchVideos.externalId],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    if (row === undefined) {
      throw new Error("research video was not stored");
    }
    const snapshot = metricsChanged(existing, row);
    if (snapshot) {
      await executor.insert(researchVideoSnapshots).values({
        videoId: row.id,
        views: row.views,
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
      });
    }
    stored.push({
      id: row.id,
      externalId: row.externalId,
      created: existing === undefined,
      snapshot,
    });
    known.set(row.externalId, row);
  }
  return stored;
}

/**
 * Derives each account's `median_views` from its `RESEARCH_MEDIAN_VIDEOS` most recent videos with
 * views (by posting time, first seen when unknown), then every one of its videos' outlier score.
 */
export async function recomputeAccounts(
  executor: Executor,
  accountIds: readonly string[],
): Promise<void> {
  for (const accountId of new Set(accountIds)) {
    const recent = await executor
      .select({ views: researchVideos.views })
      .from(researchVideos)
      .where(and(eq(researchVideos.accountId, accountId), isNotNull(researchVideos.views)))
      .orderBy(
        desc(sql`coalesce(${researchVideos.postedAt}, ${researchVideos.firstSeenAt})`),
        desc(researchVideos.id),
      )
      .limit(RESEARCH_MEDIAN_VIDEOS);
    const medianViews = median(recent.flatMap((row) => (row.views === null ? [] : [row.views])));
    await executor
      .update(researchAccounts)
      .set({ medianViews })
      .where(eq(researchAccounts.id, accountId));
    // The same rule as `outlierScore`, applied to every video of the account in one statement.
    await executor
      .update(researchVideos)
      .set({
        outlierScore:
          medianViews === null || medianViews <= 0
            ? null
            : sql`round(${researchVideos.views}::numeric / ${medianViews}, 2)::float8`,
      })
      .where(eq(researchVideos.accountId, accountId));
  }
}

function postedAt(timestamp: string | null): Date | null {
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The videos among posts Business Discovery read, as research videos: Reels and other videos,
 * keyed by the shortcode of their link (the Graph media id when the link has none).
 */
export function discoveredVideos(media: readonly DiscoveredMedia[]): VideoWrite[] {
  const videos = new Map<string, VideoWrite>();
  for (const item of media) {
    if (!isVideo(item)) continue;
    const url = item.permalink === null ? null : publicVideoLink(item.permalink, "instagram");
    const externalId =
      (url === null ? null : researchExternalIdFromUrl("instagram", url)) ?? item.id;
    if (videos.has(externalId)) continue;
    videos.set(externalId, {
      externalId,
      source: "business_discovery",
      url,
      caption: item.caption?.slice(0, RESEARCH_LIMITS.caption) ?? null,
      postedAt: postedAt(item.timestamp),
      views: item.viewCount,
      likes: item.likeCount,
      comments: item.commentsCount,
    });
  }
  return [...videos.values()];
}

/** What Business Discovery read of one Instagram account. */
export interface InstagramDiscoveryWrite {
  workspaceId: string;
  /** Already normalised with `normalizeResearchHandle`. */
  handle: string;
  displayName: string | null;
  followers: number | null;
  media: readonly DiscoveredMedia[];
  competitorId?: string | null | undefined;
  /** When the official API answered. */
  syncedAt: Date;
}

/**
 * Stores an Instagram account and every video Business Discovery read of it, then recomputes the
 * account. The account becomes `tracked`, since someone asked for it. Returns the account as
 * recomputed and the videos stored.
 */
export async function storeInstagramDiscovery(
  executor: Executor,
  input: InstagramDiscoveryWrite,
): Promise<{ account: ResearchAccountRow; videos: StoredVideo[] }> {
  const account = await upsertAccount(executor, input.workspaceId, {
    platform: "instagram",
    handle: input.handle,
    source: "tracked",
    displayName: input.displayName?.slice(0, RESEARCH_LIMITS.displayName) ?? undefined,
    followers: input.followers ?? undefined,
    competitorId: input.competitorId ?? undefined,
    lastSyncedAt: input.syncedAt,
  });
  const videos = await upsertVideos(executor, account, discoveredVideos(input.media));
  await recomputeAccounts(executor, [account.id]);
  const [fresh] = await executor
    .select()
    .from(researchAccounts)
    .where(eq(researchAccounts.id, account.id));
  return { account: fresh ?? account, videos };
}
