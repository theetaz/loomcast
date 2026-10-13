import { type JsonObject, type PublishRequest, PublishRequestSchema } from "@loomcast/contracts";
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
import { redactRequest } from "./redact";
import { UNCONNECTED_ACCOUNT_ID } from "./requests/types";
import type {
  ChannelCredentials,
  PublishChannel,
  PublishContext,
  PublishMedia,
  PublishPost,
} from "./types";

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

  const videoUrl = memo(async () =>
    dryRun
      ? dryRunMediaUrl(post.id, media.sha256, extensionForMime(media.mime))
      : promote(services, media.renderAssetId),
  );

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
    if (media.durationMs === null || media.durationMs < 1) {
      throw PublishFailure.of("invalid_media", "The render has no duration.", {
        retryable: false,
      });
    }
    const externalId = channel.externalId ?? (dryRun ? UNCONNECTED_ACCOUNT_ID : null);
    if (externalId === null) {
      throw PublishFailure.of("not_configured", "The channel has no platform account.", {
        retryable: false,
      });
    }
    const poster = await posterUrl();
    const parsed = PublishRequestSchema.safeParse({
      platform: channel.platform,
      externalId,
      videoUrl: await videoUrl(),
      ...(poster === null ? {} : { posterUrl: poster }),
      caption: fitted().text,
      durationMs: media.durationMs,
      width: media.width ?? DEFAULT_RENDER_WIDTH,
      height: media.height ?? DEFAULT_RENDER_HEIGHT,
    });
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
      throw PublishFailure.of(
        fields.some((field) => field === "videoUrl" || field === "posterUrl")
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
