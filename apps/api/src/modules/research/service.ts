import {
  COMPETITOR_PLATFORMS,
  normalizeReferenceUrl,
  normalizeResearchHandle,
  normalizeTopic,
  RESEARCH_LIMITS,
  RESEARCH_TOPIC_WINDOW_DAYS,
  type ResearchAccount,
  type ResearchAccountSource,
  type ResearchListVideosInput,
  type ResearchPlatform,
  type ResearchSyncStatus,
  type ResearchTagVideoInput,
  type ResearchTopTopicsOutput,
  type ResearchVideo,
  type ResearchVideoInput,
  researchExternalIdFromUrl,
} from "@loomcast/contracts";
import {
  competitors,
  contentItems,
  latestPostMetrics,
  type ResearchAccountRow,
  type ResearchVideoRow,
  researchAccounts,
  researchVideos,
  scheduledPosts,
} from "@loomcast/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import type { Clock } from "../../lib/clock";
import { transaction } from "../../lib/db";
import { HttpError, validationFailed } from "../../lib/errors";
import { type DiscoveryDeps, lookupInstagramAccount } from "../competitors/discovery";
import { type OwnTopicPost, topicLeaderboard } from "./math";
import {
  recomputeAccounts,
  type StoredVideo,
  storeInstagramDiscovery,
  upsertAccount,
  upsertVideos,
  type VideoWrite,
} from "./store";

const DAY_MS = 24 * 60 * 60_000;

/**
 * Lookup failures a sync reports instead of throwing: no channel or no Meta app (`skipped`), and
 * an account Instagram does not share or a refused call (`failed`).
 */
const SYNC_REFUSALS: ReadonlySet<string> = new Set([
  "no_instagram_channel",
  "not_configured",
  "not_professional_account",
  "platform_error",
]);

export interface ResearchServiceDeps extends DiscoveryDeps {
  clock: Clock;
}

export interface AddVideosResult {
  created: number;
  updated: number;
  snapshots: number;
  videos: (StoredVideo & { accountId: string; handle: string; outlierScore: number | null })[];
}

export interface SyncResult {
  account: ResearchAccount;
  sync: ResearchSyncStatus;
}

export interface TopTopicsQuery {
  windowDays?: number | undefined;
  minHitCreators?: number | undefined;
  limit?: number | undefined;
}

export interface ResearchService {
  getAccount(id: string): Promise<ResearchAccount | null>;
  listAccounts(
    workspaceId: string,
    filter?: {
      platform?: ResearchPlatform | undefined;
      source?: ResearchAccountSource | undefined;
    },
  ): Promise<ResearchAccount[]>;
  /** Follows an account; for Instagram (unless `sync` is false) reads it at once. */
  trackAccount(
    workspaceId: string,
    input: {
      platform: ResearchPlatform;
      handle: string;
      notes?: string | undefined;
      sync?: boolean;
    },
  ): Promise<SyncResult>;
  /** Refreshes an Instagram account through Business Discovery. Null when it does not exist. */
  syncAccount(id: string): Promise<SyncResult | null>;
  addVideos(workspaceId: string, videos: readonly ResearchVideoInput[]): Promise<AddVideosResult>;
  tagVideos(
    input: ResearchTagVideoInput,
  ): Promise<{ updated: number; missing: string[]; workspaceIds: string[] }>;
  listVideos(
    workspaceId: string,
    filter: Omit<ResearchListVideosInput, "workspace">,
  ): Promise<{ videos: ResearchVideo[]; nextCursor: string | null }>;
  topTopics(workspaceId: string, query: TopTopicsQuery): Promise<ResearchTopTopicsOutput>;
}

/** The handle as stored, or `400 validation_failed` naming `path`. */
function handleOf(input: string, path: string): string {
  const handle = normalizeResearchHandle(input);
  if (handle === null) {
    throw validationFailed([{ path, message: "Use the account's handle: letters, digits, . _ -" }]);
  }
  return handle;
}

function topicOf(input: string, path: string): string {
  const topic = normalizeTopic(input);
  if (topic === null) {
    throw validationFailed([{ path, message: "The topic needs letters or digits" }]);
  }
  return topic;
}

function tagsOf(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== ""))];
}

function toAccount(row: ResearchAccountRow, videoCount: number): ResearchAccount {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    platform: row.platform,
    handle: row.handle,
    displayName: row.displayName,
    followers: row.followers,
    medianViews: row.medianViews,
    source: row.source,
    competitorId: row.competitorId,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    notes: row.notes,
    videoCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function toVideo(row: ResearchVideoRow, handle: string): ResearchVideo {
  return {
    id: row.id,
    accountId: row.accountId,
    handle,
    platform: row.platform,
    externalId: row.externalId,
    url: row.url,
    caption: row.caption,
    postedAt: row.postedAt?.toISOString() ?? null,
    durationS: row.durationS,
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    outlierScore: row.outlierScore,
    topic: row.topic,
    tags: row.tags,
    hook: row.hook,
    format: row.format,
    notes: row.notes,
    source: row.source,
    firstSeenAt: row.firstSeenAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The link as the knowledge base stores links (tracking parameters dropped), or as given. */
function cleanUrl(url: string): string {
  try {
    return normalizeReferenceUrl(url).url;
  } catch {
    return url;
  }
}

const CURSOR_RE = /^o:(\d{1,9})$/;

function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = CURSOR_RE.exec(cursor);
  if (match?.[1] === undefined) {
    throw validationFailed([{ path: "cursor", message: "Pass nextCursor from the last page" }]);
  }
  return Number(match[1]);
}

/** When a video was posted, or first seen when the posting time is unknown. */
const videoTime = sql<Date>`coalesce(${researchVideos.postedAt}, ${researchVideos.firstSeenAt})`;

/** The research service: accounts, videos and the topic leaderboard of each workspace. */
export function createResearchService(deps: ResearchServiceDeps): ResearchService {
  const { db, clock } = deps;

  async function videoCounts(accountIds: readonly string[]): Promise<Map<string, number>> {
    if (accountIds.length === 0) return new Map();
    const rows = await db
      .select({ accountId: researchVideos.accountId, count: sql<number>`count(*)::int` })
      .from(researchVideos)
      .where(inArray(researchVideos.accountId, [...accountIds]))
      .groupBy(researchVideos.accountId);
    return new Map(rows.map((row) => [row.accountId, row.count]));
  }

  async function withCounts(rows: readonly ResearchAccountRow[]): Promise<ResearchAccount[]> {
    const counts = await videoCounts(rows.map((row) => row.id));
    return rows.map((row) => toAccount(row, counts.get(row.id) ?? 0));
  }

  async function loadAccount(id: string): Promise<ResearchAccount | null> {
    const [row] = await db.select().from(researchAccounts).where(eq(researchAccounts.id, id));
    return row === undefined ? null : ((await withCounts([row]))[0] ?? null);
  }

  /** The live competitor of the workspace this account mirrors, if any. */
  async function competitorOf(
    workspaceId: string,
    platform: ResearchPlatform,
    handle: string,
  ): Promise<string | null> {
    if (!(COMPETITOR_PLATFORMS as readonly string[]).includes(platform)) return null;
    const [row] = await db
      .select({ id: competitors.id })
      .from(competitors)
      .where(
        and(
          eq(competitors.workspaceId, workspaceId),
          eq(competitors.platform, platform as (typeof COMPETITOR_PLATFORMS)[number]),
          sql`lower(${competitors.handle}) = ${handle}`,
          isNull(competitors.deletedAt),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  /** Reads an Instagram account through Business Discovery and stores what it found. */
  async function syncInstagram(account: ResearchAccountRow): Promise<SyncResult> {
    let lookup: Awaited<ReturnType<typeof lookupInstagramAccount>>;
    try {
      lookup = await lookupInstagramAccount(deps, {
        workspaceId: account.workspaceId,
        handle: account.handle,
      });
    } catch (error) {
      if (!(error instanceof HttpError) || !SYNC_REFUSALS.has(error.code)) {
        throw error;
      }
      const skipped = error.code === "no_instagram_channel" || error.code === "not_configured";
      return {
        account: (await loadAccount(account.id)) ?? toAccount(account, 0),
        sync: { status: skipped ? "skipped" : "failed", videos: 0, message: error.message },
      };
    }
    const { result } = lookup;
    const stored = await transaction(db, (tx) =>
      storeInstagramDiscovery(tx, {
        workspaceId: account.workspaceId,
        handle: account.handle,
        displayName: result.name,
        followers: result.followersCount,
        media: result.media,
        syncedAt: clock.now(),
      }),
    );
    return {
      account: (await loadAccount(stored.account.id)) ?? toAccount(stored.account, 0),
      sync: { status: "synced", videos: stored.videos.length, message: null },
    };
  }

  return {
    getAccount: loadAccount,

    async listAccounts(workspaceId, filter = {}) {
      const rows = await db
        .select()
        .from(researchAccounts)
        .where(
          and(
            eq(researchAccounts.workspaceId, workspaceId),
            filter.platform === undefined
              ? undefined
              : eq(researchAccounts.platform, filter.platform),
            filter.source === undefined ? undefined : eq(researchAccounts.source, filter.source),
          ),
        )
        .orderBy(asc(researchAccounts.platform), asc(researchAccounts.handle));
      return withCounts(rows);
    },

    async trackAccount(workspaceId, input) {
      const handle = handleOf(input.handle, "handle");
      const account = await upsertAccount(db, workspaceId, {
        platform: input.platform,
        handle,
        source: "tracked",
        notes: input.notes,
        competitorId: await competitorOf(workspaceId, input.platform, handle),
      });
      if (input.platform !== "instagram" || input.sync === false) {
        const message =
          input.platform === "instagram"
            ? "Not synced: sync was false."
            : "Stored only: the official API reads Instagram accounts. Add videos with research.add_videos.";
        return {
          account: (await loadAccount(account.id)) ?? toAccount(account, 0),
          sync: { status: "skipped", videos: 0, message },
        };
      }
      return syncInstagram(account);
    },

    async syncAccount(id) {
      const [account] = await db.select().from(researchAccounts).where(eq(researchAccounts.id, id));
      if (account === undefined) return null;
      if (account.platform !== "instagram") {
        return {
          account: (await loadAccount(id)) ?? toAccount(account, 0),
          sync: {
            status: "skipped",
            videos: 0,
            message: "Only Instagram accounts can be refreshed through the official API.",
          },
        };
      }
      return syncInstagram(account);
    },

    async addVideos(workspaceId, videos) {
      // Checked up front, so a bad entry stores nothing.
      const issues: { path: string; message: string }[] = [];
      const groups = new Map<
        string,
        {
          platform: ResearchPlatform;
          handle: string;
          displayName?: string;
          followers?: number;
          writes: VideoWrite[];
        }
      >();
      videos.forEach((video, index) => {
        const handle = normalizeResearchHandle(video.handle);
        const externalId =
          (video.url === undefined ? null : researchExternalIdFromUrl(video.platform, video.url)) ??
          video.externalId ??
          null;
        const topic = video.topic === undefined ? undefined : normalizeTopic(video.topic);
        if (handle === null) {
          issues.push({ path: `videos.${index}.handle`, message: "Not a valid handle" });
        }
        if (externalId === null) {
          issues.push({
            path: `videos.${index}.url`,
            message: "The link has no recognisable video id; give externalId",
          });
        }
        if (topic === null) {
          issues.push({
            path: `videos.${index}.topic`,
            message: "The topic needs letters or digits",
          });
        }
        if (handle === null || externalId === null || topic === null) return;
        const key = `${video.platform}|${handle}`;
        const group = groups.get(key) ?? { platform: video.platform, handle, writes: [] };
        if (video.displayName !== undefined) group.displayName = video.displayName;
        if (video.followers !== undefined) group.followers = video.followers;
        group.writes.push({
          externalId,
          source: video.source ?? "agent",
          url: video.url === undefined ? undefined : cleanUrl(video.url),
          caption: video.caption,
          postedAt: video.postedAt === undefined ? undefined : new Date(video.postedAt),
          durationS: video.durationS,
          views: video.views,
          likes: video.likes,
          comments: video.comments,
          shares: video.shares,
          topic,
          tags: video.tags === undefined ? undefined : tagsOf(video.tags),
          hook: video.hook,
          format: video.format,
          notes: video.notes,
        });
        groups.set(key, group);
      });
      if (issues.length > 0) {
        throw validationFailed(issues, "Some videos cannot be stored.");
      }

      return transaction(db, async (tx) => {
        const stored: AddVideosResult["videos"] = [];
        const accountIds: string[] = [];
        for (const group of groups.values()) {
          const account = await upsertAccount(tx, workspaceId, {
            platform: group.platform,
            handle: group.handle,
            source: "discovered",
            displayName: group.displayName,
            followers: group.followers,
          });
          accountIds.push(account.id);
          for (const video of await upsertVideos(tx, account, group.writes)) {
            stored.push({
              ...video,
              accountId: account.id,
              handle: account.handle,
              outlierScore: null,
            });
          }
        }
        await recomputeAccounts(tx, accountIds);
        const scores = new Map(
          (
            await tx
              .select({ id: researchVideos.id, outlierScore: researchVideos.outlierScore })
              .from(researchVideos)
              .where(
                inArray(
                  researchVideos.id,
                  stored.map((video) => video.id),
                ),
              )
          ).map((row) => [row.id, row.outlierScore]),
        );
        const videosOut = stored.map((video) => ({
          ...video,
          outlierScore: scores.get(video.id) ?? null,
        }));
        return {
          created: videosOut.filter((video) => video.created).length,
          updated: videosOut.filter((video) => !video.created).length,
          snapshots: videosOut.filter((video) => video.snapshot).length,
          videos: videosOut,
        };
      });
    },

    async tagVideos(input) {
      const set: Partial<Pick<ResearchVideoRow, "topic" | "tags" | "hook" | "format" | "notes">> =
        {};
      if (input.topic !== undefined) set.topic = topicOf(input.topic, "topic");
      if (input.tags !== undefined) set.tags = tagsOf(input.tags);
      if (input.hook !== undefined) set.hook = input.hook;
      if (input.format !== undefined) set.format = input.format;
      if (input.notes !== undefined) set.notes = input.notes;
      const ids = [...new Set(input.videoIds)];
      const rows = await db
        .update(researchVideos)
        .set({ ...set, updatedAt: clock.now() })
        .where(inArray(researchVideos.id, ids))
        .returning({ id: researchVideos.id, workspaceId: researchVideos.workspaceId });
      const found = new Set(rows.map((row) => row.id));
      return {
        updated: rows.length,
        missing: ids.filter((id) => !found.has(id)),
        workspaceIds: [...new Set(rows.map((row) => row.workspaceId))],
      };
    },

    async listVideos(workspaceId, filter) {
      const limit = filter.limit ?? RESEARCH_LIMITS.listDefault;
      const offset = offsetOf(filter.cursor);
      const where: SQL[] = [eq(researchVideos.workspaceId, workspaceId)];
      if (filter.platform !== undefined) where.push(eq(researchVideos.platform, filter.platform));
      if (filter.handle !== undefined) {
        where.push(eq(researchAccounts.handle, handleOf(filter.handle, "handle")));
      }
      if (filter.topic !== undefined) {
        where.push(eq(researchVideos.topic, topicOf(filter.topic, "topic")));
      }
      if (filter.untaggedOnly === true) where.push(isNull(researchVideos.topic));
      if (filter.minOutlier !== undefined) {
        where.push(gte(researchVideos.outlierScore, filter.minOutlier));
      }
      if (filter.minViews !== undefined) where.push(gte(researchVideos.views, filter.minViews));
      if (filter.since !== undefined) where.push(gte(videoTime, new Date(filter.since)));
      const order =
        filter.sort === "views"
          ? [sql`${researchVideos.views} desc nulls last`]
          : filter.sort === "recent"
            ? [desc(videoTime)]
            : [
                sql`${researchVideos.outlierScore} desc nulls last`,
                sql`${researchVideos.views} desc nulls last`,
              ];
      const rows = await db
        .select({ video: researchVideos, handle: researchAccounts.handle })
        .from(researchVideos)
        .innerJoin(researchAccounts, eq(researchAccounts.id, researchVideos.accountId))
        .where(and(...where))
        .orderBy(...order, asc(researchVideos.id))
        .limit(limit + 1)
        .offset(offset);
      const page = rows.slice(0, limit);
      return {
        videos: page.map((row) => toVideo(row.video, row.handle)),
        nextCursor: rows.length > limit ? `o:${offset + limit}` : null,
      };
    },

    async topTopics(workspaceId, query) {
      const windowDays = query.windowDays ?? RESEARCH_TOPIC_WINDOW_DAYS;
      const now = clock.now();
      const from = new Date(now.getTime() - windowDays * DAY_MS);
      const videos = await db
        .select({
          id: researchVideos.id,
          accountId: researchVideos.accountId,
          handle: researchAccounts.handle,
          url: researchVideos.url,
          topic: researchVideos.topic,
          views: researchVideos.views,
          outlierScore: researchVideos.outlierScore,
          postedAt: researchVideos.postedAt,
          firstSeenAt: researchVideos.firstSeenAt,
        })
        .from(researchVideos)
        .innerJoin(researchAccounts, eq(researchAccounts.id, researchVideos.accountId))
        .where(and(eq(researchVideos.workspaceId, workspaceId), gte(videoTime, from)));

      // Our own live posts, joined by their content item's topic.
      const posts = await db
        .select({ postId: scheduledPosts.id, topic: contentItems.topic })
        .from(scheduledPosts)
        .innerJoin(contentItems, eq(contentItems.id, scheduledPosts.itemId))
        .where(
          and(
            eq(contentItems.workspaceId, workspaceId),
            eq(scheduledPosts.status, "published"),
            eq(scheduledPosts.dryRun, false),
            isNotNull(contentItems.topic),
          ),
        );
      const latest = new Map(
        (
          await latestPostMetrics(
            db,
            posts.map((post) => post.postId),
          )
        ).map((row) => [row.postId, row.views]),
      );
      const own: OwnTopicPost[] = posts.flatMap((post) => {
        const topic = post.topic === null ? null : normalizeTopic(post.topic);
        return topic === null ? [] : [{ topic, views: latest.get(post.postId) ?? null }];
      });

      const board = topicLeaderboard(
        videos.map((video) => ({
          id: video.id,
          accountId: video.accountId,
          handle: video.handle,
          url: video.url,
          topic: video.topic,
          views: video.views,
          outlierScore: video.outlierScore,
          at: video.postedAt ?? video.firstSeenAt,
        })),
        own,
        {
          now,
          windowDays,
          minHitCreators: query.minHitCreators ?? 0,
          limit: query.limit ?? RESEARCH_LIMITS.topicsDefault,
        },
      );
      return { windowDays, from: from.toISOString(), ...board };
    },
  };
}
