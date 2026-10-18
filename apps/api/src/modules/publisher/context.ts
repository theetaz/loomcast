import {
  formatMediaIssues,
  type JsonObject,
  type PublishRequest,
  PublishRequestSchema,
} from "@loomcast/contracts";
import { channels, type Database } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { HttpError } from "../../lib/errors";
import type { Logger } from "../../lib/logger";
import type { Storage } from "../../lib/storage";
import { extensionForMime } from "../../lib/storage/keys";
import { channelAad, sealedSecretOf, type TokenVault, VaultError } from "../../lib/vault";
import type { AssetsService } from "../assets/service";
import { dryRunMediaUrl } from "./adapters/dry-run";
import { buildCaption, type CaptionParts, type FittedCaption } from "./caption";
import { PublishFailure } from "./errors";
import { videoOf } from "./media";
import { redactRequest } from "./redact";
import { UNCONNECTED_ACCOUNT_ID } from "./requests/types";
import type {
  ChannelCredentials,
  PublishChannel,
  PublishContext,
  PublishFile,
  PublishMedia,
  PublishPost,
} from "./types";

export { videoFacts, videoOf } from "./media";

/** Size of a render that reports none: the 9:16 frame (`STORYBOARD_ASPECT`) formats render at. */
export const DEFAULT_RENDER_WIDTH = 1_080;
export const DEFAULT_RENDER_HEIGHT = 1_920;

export interface ContextServices {
  db: Database;
  vault: TokenVault;
  storage: Storage;
  assets: Pick<AssetsService, "getRow">;
}

export interface ContextInput {
  dryRun: boolean;
  post: PublishPost;
  channel: PublishChannel;
  media: PublishMedia;
  captionParts: CaptionParts;
  signal: AbortSignal;
  logger: Logger;
  now(): Date;
}

/** What an adapter recorded on the attempt, already redacted. */
export interface RecordedExchange {
  request: JsonObject | null;
  response: JsonObject | null;
}

export interface BuiltContext {
  context: PublishContext;
  recorded(): RecordedExchange;
}

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | null = null;
  return () => {
    value ??= load().catch((error: unknown) => {
      value = null;
      throw error;
    });
    return value;
  };
}

async function readCredentials(
  services: ContextServices,
  channelId: string,
): Promise<ChannelCredentials> {
  const [row] = await services.db
    .select({
      secretCiphertext: channels.secretCiphertext,
      secretNonce: channels.secretNonce,
      keyVersion: channels.keyVersion,
    })
    .from(channels)
    .where(eq(channels.id, channelId));
  const sealed = row === undefined ? null : sealedSecretOf(row);
  if (sealed === null) {
    throw PublishFailure.of("not_configured", "The channel is not connected.", {
      retryable: false,
    });
  }
  let value: JsonObject;
  try {
    value = services.vault.decrypt(sealed, channelAad(channelId));
  } catch (error) {
    if (error instanceof VaultError) {
      throw PublishFailure.of(
        "auth",
        "The channel's stored credentials cannot be read; reconnect it.",
        { retryable: false },
      );
    }
    if (error instanceof HttpError) {
      throw PublishFailure.of("not_configured", "Credential encryption is not configured.", {
        retryable: false,
      });
    }
    throw error;
  }
  if (typeof value.accessToken !== "string" || value.accessToken === "") {
    throw PublishFailure.of("auth", "The channel's stored credentials have no access token.", {
      retryable: false,
    });
  }
  return value as ChannelCredentials;
}

async function promote(services: ContextServices, assetId: string): Promise<string> {
  const row = await services.assets.getRow(assetId);
  if (row === null || row.status !== "ready") {
    throw PublishFailure.of("invalid_media", "The file to publish is missing.", {
      retryable: false,
    });
  }
  try {
    const promoted = await services.storage.promoteToPublic(row.storageKey);
    return promoted.url;
  } catch {
    throw PublishFailure.of("transient", "The file could not be copied to public storage.");
  }
}

/**
 * Builds the context of one adapter call. In dry-run nothing here touches credentials or object
 * storage: `secrets` refuses, and the public URLs are `dryRunMediaUrl` placeholders.
 */
export function createPublishContext(services: ContextServices, input: ContextInput): BuiltContext {
  const { dryRun, post, channel, media } = input;
  let request: JsonObject | null = null;
  let response: JsonObject | null = null;
  let caption: FittedCaption | null = null;

  const secrets = memo(async () => {
    if (dryRun) {
      throw new Error("a dry-run post never reads channel credentials");
    }
    return readCredentials(services, channel.id);
  });

  const publicUrl = (file: Pick<PublishFile, "assetId" | "sha256" | "mime">): Promise<string> =>
    dryRun
      ? Promise.resolve(dryRunMediaUrl(post.id, file.sha256, extensionForMime(file.mime)))
      : promote(services, file.assetId);

  const videoUrl = memo(async () => publicUrl(videoOf(media)));

  const itemUrls = memo(async () => {
    const urls: string[] = [];
    // One at a time: each copy is a new public object, so a failure stops before the rest.
    for (const item of media.items) {
      urls.push(await publicUrl(item));
    }
    return urls;
  });

  const posterUrl = memo(async (): Promise<string | null> => {
    if (media.posterAssetId === null) {
      return null;
    }
    if (dryRun) {
      const poster = await services.assets.getRow(media.posterAssetId);
      return poster === null
        ? null
        : dryRunMediaUrl(post.id, poster.sha256, extensionForMime(poster.mime));
    }
    return promote(services, media.posterAssetId);
  });

  const fitted = (): FittedCaption => {
    caption ??= buildCaption(channel.platform, input.captionParts);
    return caption;
  };

  const publishRequest = memo(async (): Promise<PublishRequest> => {
    const externalId = channel.externalId ?? (dryRun ? UNCONNECTED_ACCOUNT_ID : null);
    if (externalId === null) {
      throw PublishFailure.of("not_configured", "The channel has no platform account.", {
        retryable: false,
      });
    }
    const base = {
      platform: channel.platform,
      externalId,
      caption: fitted().text,
      ...(Object.keys(post.options).length === 0 ? {} : { options: post.options }),
    };
    let candidate: unknown;
    switch (media.format) {
      case "reel":
      case "video": {
        const video = videoOf(media);
        if (video.durationMs === null || video.durationMs < 1) {
          throw PublishFailure.of("invalid_media", "The video has no duration.", {
            retryable: false,
          });
        }
        const poster = await posterUrl();
        candidate = {
          ...base,
          format: media.format,
          videoUrl: await videoUrl(),
          ...(poster === null ? {} : { posterUrl: poster }),
          durationMs: video.durationMs,
          width: video.width ?? DEFAULT_RENDER_WIDTH,
          height: video.height ?? DEFAULT_RENDER_HEIGHT,
        };
        break;
      }
      case "image":
      case "carousel":
      case "story": {
        const issues = formatMediaIssues({ format: media.format, media: media.items });
        if (issues.length > 0) {
          throw PublishFailure.of("invalid_media", issues.join(" "), { retryable: false });
        }
        const urls = await itemUrls();
        candidate = {
          ...base,
          format: media.format,
          media: media.items.map((item, index) => ({
            type: item.type,
            url: urls[index],
            mime: item.mime,
            bytes: item.bytes,
            width: item.width,
            height: item.height,
            durationMs: item.durationMs,
            ...(item.altText === undefined || item.altText === "" ? {} : { altText: item.altText }),
          })),
        };
        break;
      }
      case "text":
        candidate = { ...base, format: "text" };
        break;
    }
    const parsed = PublishRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
      throw PublishFailure.of(
        fields.some((field) => /^(videoUrl|posterUrl|media\.\d+\.url)$/.test(field))
          ? "not_configured"
          : "invalid_media",
        `The post cannot be sent as it is (${fields.join(", ")}).`,
        { retryable: false },
      );
    }
    return parsed.data;
  });

  const context: PublishContext = {
    platform: channel.platform,
    dryRun,
    post,
    channel,
    media,
    secrets,
    getPublicVideoUrl: videoUrl,
    getPublicItemUrls: itemUrls,
    getPublicPosterUrl: posterUrl,
    caption: fitted,
    publishRequest,
    record(part) {
      if (part.request !== undefined) {
        request = redactRequest(part.request);
      }
      if (part.response !== undefined) {
        response = redactRequest(part.response);
      }
    },
    signal: input.signal,
    logger: input.logger,
    now: input.now,
  };

  return { context, recorded: () => ({ request, response }) };
}
