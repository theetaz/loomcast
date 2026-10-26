import {
  COMPETITOR_CAPTION_MAX_LENGTH,
  COMPETITOR_DISCOVERY_MAX_POSTS,
  COMPETITOR_HANDLE_RE,
  type CompetitorAccount,
  type CompetitorPlatform,
  isPublicVideoUrl,
  normalizeReferenceUrl,
} from "@loomcast/contracts";
import { channels, type Database } from "@loomcast/db";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { PlatformsConfig } from "../../env";
import { HttpError } from "../../lib/errors";
import type { Logger } from "../../lib/logger";
import {
  BUSINESS_DISCOVERY_NOT_FOUND_SUBCODE,
  businessDiscovery,
  createMetaGraphClient,
  type DiscoveredMedia,
  type GraphClient,
  MetaGraphError,
} from "../../lib/meta-graph";
import { channelAad, sealedSecretOf, type TokenVault, VaultError } from "../../lib/vault";

// Where a scan's videos come from: the competitor's most viewed Instagram videos, ranked through
// the Graph API's Business Discovery with the token of one of the workspace's Instagram channels,
// or the links a user pasted. Either way every link passes `isPublicVideoUrl` before it is stored,
// because the studio agent downloads it later. The token never leaves this file: it is not logged,
// returned or put in a job payload.

/** One video a scan picked, with its numbers at scan time. */
export interface PickedVideo {
  /** The normalised public video link. */
  url: string;
  externalId: string | null;
  caption: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  postedAt: Date | null;
}

export interface Discovery {
  videos: PickedVideo[];
  account: CompetitorAccount;
  /** The Instagram channel whose token was used. */
  channelId: string;
}

const PLATFORM_LABELS: Readonly<Record<CompetitorPlatform, string>> = {
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
};

/** `422` with a code the web app explains, such as `not_professional_account`. */
export function unprocessable(code: string, message: string, details?: unknown): HttpError {
  return new HttpError(422, code, message, details);
}

/** The normalised link when it is a public video of `platform`, otherwise null. */
export function publicVideoLink(link: string, platform: CompetitorPlatform): string | null {
  let url: string;
  try {
    url = normalizeReferenceUrl(link).url;
  } catch {
    return null;
  }
  return isPublicVideoUrl(url, platform) ? url : null;
}

/**
 * The pasted links as videos, in the order given, without repeats. `422 invalid_link` lists every
 * link that is not a public video of the competitor's platform.
 */
export function linkedVideos(
  links: readonly string[],
  platform: CompetitorPlatform,
): PickedVideo[] {
  const issues: { path: string; message: string }[] = [];
  const videos: PickedVideo[] = [];
  const seen = new Set<string>();
  links.forEach((link, index) => {
    const url = publicVideoLink(link, platform);
    if (url === null) {
      issues.push({
        path: `links.${index}`,
        message: `Paste a link to one public ${PLATFORM_LABELS[platform]} video`,
      });
      return;
    }
    if (!seen.has(url)) {
      seen.add(url);
      videos.push({
        url,
        externalId: null,
        caption: null,
        views: null,
        likes: null,
        comments: null,
        postedAt: null,
      });
    }
  });
  if (issues.length > 0) {
    throw unprocessable(
      "invalid_link",
      "Some links are not public video links of the competitor's platform.",
      issues,
    );
  }
  return videos;
}

function isVideo(media: DiscoveredMedia): boolean {
  return media.mediaProductType === "REELS" || media.mediaType === "VIDEO";
}

function engagement(media: DiscoveredMedia): number {
  return (media.likeCount ?? 0) + (media.commentsCount ?? 0);
}

function postedAt(timestamp: string | null): Date | null {
  if (timestamp === null) {
    return null;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The `topN` most popular videos among `media`: Reels and other videos with a public permalink,
 * ranked by views (posts without a view count last), then likes plus comments, then the newest.
 */
export function rankVideos(media: readonly DiscoveredMedia[], topN: number): PickedVideo[] {
  const candidates: { media: DiscoveredMedia; url: string }[] = [];
  const seen = new Set<string>();
  for (const item of media) {
    const url = item.permalink === null ? null : publicVideoLink(item.permalink, "instagram");
    if (isVideo(item) && url !== null && !seen.has(url)) {
      seen.add(url);
      candidates.push({ media: item, url });
    }
  }
  candidates.sort(
    (a, b) =>
      (b.media.viewCount ?? -1) - (a.media.viewCount ?? -1) ||
      engagement(b.media) - engagement(a.media) ||
      (postedAt(b.media.timestamp)?.getTime() ?? 0) - (postedAt(a.media.timestamp)?.getTime() ?? 0),
  );
  return candidates.slice(0, topN).map(({ media: item, url }) => ({
    url,
    externalId: item.id,
    caption: item.caption?.slice(0, COMPETITOR_CAPTION_MAX_LENGTH) ?? null,
    views: item.viewCount,
    likes: item.likeCount,
    comments: item.commentsCount,
    postedAt: postedAt(item.timestamp),
  }));
}

export interface DiscoveryDeps {
  db: Database;
  vault: TokenVault;
  platforms: PlatformsConfig;
  logger: Logger;
  /** The Graph API client; defaults to `createMetaGraphClient(platforms)`. */
  graph?: () => GraphClient;
}

interface InstagramChannel {
  id: string;
  igUserId: string;
  accessToken: string;
}

/**
 * The active Instagram channel `channelId` of the workspace, or else the first one connected,
 * preferring the workspace's own (a lookup only needs some account's token, so a workspace without
 * an Instagram account can still rank), with its access token opened from the vault.
 * `422 no_instagram_channel` when there is none or its token cannot be read.
 */
async function instagramChannel(
  deps: DiscoveryDeps,
  workspaceId: string,
  channelId: string | undefined,
): Promise<InstagramChannel> {
  const [row] = await deps.db
    .select({
      id: channels.id,
      externalId: channels.externalId,
      secretCiphertext: channels.secretCiphertext,
      secretNonce: channels.secretNonce,
      keyVersion: channels.keyVersion,
    })
    .from(channels)
    .where(
      and(
        eq(channels.platform, "instagram"),
        eq(channels.status, "active"),
        isNotNull(channels.externalId),
        channelId === undefined
          ? undefined
          : and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)),
      ),
    )
    .orderBy(
      desc(sql`${channels.workspaceId} = ${workspaceId}`),
      asc(channels.createdAt),
      asc(channels.id),
    )
    .limit(1);
  const sealed = row === undefined ? null : sealedSecretOf(row);
  if (row === undefined || row.externalId === null || sealed === null) {
    throw unprocessable(
      "no_instagram_channel",
      channelId === undefined
        ? "Connect an Instagram account to rank a competitor's videos, or paste the links."
        : "That channel is not a connected Instagram account.",
    );
  }
  let accessToken: unknown;
  try {
    accessToken = deps.vault.decrypt(sealed, channelAad(row.id)).accessToken;
  } catch (error) {
    if (error instanceof VaultError) {
      accessToken = undefined;
    } else {
      throw error;
    }
  }
  if (typeof accessToken !== "string" || accessToken === "") {
    throw unprocessable(
      "no_instagram_channel",
      "The Instagram channel's credentials cannot be read; reconnect it.",
    );
  }
  return { id: row.id, igUserId: row.externalId, accessToken };
}

/**
 * Ranks an Instagram competitor's videos through Business Discovery and returns the top `topN`
 * with the account's public numbers. `422 not_professional_account` when the account is unknown
 * or is not a business or creator account; `422 no_videos` when it has no video to analyse;
 * `502 platform_error` when the Graph API refuses the call for another reason.
 */
export async function discoverInstagramVideos(
  deps: DiscoveryDeps,
  input: { workspaceId: string; handle: string; topN: number; channelId?: string | undefined },
): Promise<Discovery> {
  if (!COMPETITOR_HANDLE_RE.test(input.handle)) {
    throw unprocessable("not_professional_account", "The handle cannot be looked up.");
  }
  if (deps.platforms.meta === null) {
    throw new HttpError(503, "not_configured", "The Meta app is not configured on the server.");
  }
  const channel = await instagramChannel(deps, input.workspaceId, input.channelId);
  const client = deps.graph?.() ?? createMetaGraphClient(deps.platforms);
  let result: Awaited<ReturnType<typeof businessDiscovery>>;
  try {
    result = await businessDiscovery(client, {
      igUserId: channel.igUserId,
      handle: input.handle,
      accessToken: channel.accessToken,
      maxPosts: COMPETITOR_DISCOVERY_MAX_POSTS,
    });
  } catch (error) {
    if (!(error instanceof MetaGraphError)) {
      throw error;
    }
    if (error.fields.subcode === BUSINESS_DISCOVERY_NOT_FOUND_SUBCODE) {
      throw unprocessable(
        "not_professional_account",
        "Instagram only shares business and creator accounts. Paste links to the videos instead.",
      );
    }
    deps.logger.warn(
      { ...error.toLog(), channelId: channel.id },
      "competitor discovery was refused",
    );
    throw new HttpError(502, "platform_error", `Instagram refused the lookup: ${error.message}`, {
      reason: error.code,
    });
  }
  const videos = rankVideos(result.media, input.topN);
  if (videos.length === 0) {
    throw unprocessable(
      "no_videos",
      "The account has no recent videos to analyse. Paste links to the videos instead.",
    );
  }
  return {
    videos,
    account: {
      displayName: result.name?.slice(0, 300) ?? null,
      followersCount: result.followersCount,
      mediaCount: result.mediaCount,
    },
    channelId: channel.id,
  };
}
