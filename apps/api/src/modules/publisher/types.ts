import type { JsonObject, Platform, PublishError, PublishRequest } from "@loomcast/contracts";
import type { Logger } from "../../lib/logger";
import type { FittedCaption } from "./caption";
import type { MediaFacts } from "./requests/types";

// The publisher adapter contract. One adapter per platform lives in `adapters/<platform>/` and is
// listed in `adapters/index.ts`; the dry-run adapter stands in for every platform while a post is
// in dry-run. Adapters build their requests with the pure builders in `requests/`, so a dry run
// records exactly what a live run sends.

/**
 * A channel's decrypted credentials. M5 decides the full shape per platform; every connected
 * channel has at least `accessToken`.
 */
export interface ChannelCredentials {
  accessToken: string;
  [key: string]: unknown;
}

/** The channel a post goes to, without credentials. */
export interface PublishChannel {
  id: string;
  platform: Platform;
  displayName: string;
  /** The platform's account id; null for a planning channel (dry-run only). */
  externalId: string | null;
  username: string | null;
  parentChannelId: string | null;
  scopes: string[];
  meta: JsonObject;
}

/** The post being published and what earlier attempts stored. */
export interface PublishPost {
  id: string;
  itemId: string;
  versionId: string;
  scheduledAt: Date;
  /** This attempt's number, from 1. */
  attempt: number;
  /** When this attempt started; `post.check_status` gives up 20 min after it. */
  attemptStartedAt: Date;
  /** The platform's id of the published post, once known. */
  externalId: string | null;
  /** The upload or container id `publish` returned, for `status`. */
  externalContainerId: string | null;
}

/** The final render (and poster) of the approved version. */
export interface PublishMedia extends MediaFacts {
  renderAssetId: string;
  sha256: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  posterAssetId: string | null;
}

/** What an adapter call gets. Built by the publisher for each `publish`, `validate` and `status`. */
export interface PublishContext {
  readonly platform: Platform;
  /** True when nothing may leave the server: the post, the channel or the server is in dry-run. */
  readonly dryRun: boolean;
  readonly post: PublishPost;
  readonly channel: PublishChannel;
  readonly media: PublishMedia;
  /**
   * The channel's decrypted credentials, decrypted on first call. Throws a `PublishFailure`:
   * `not_configured` when the channel has none (or the server has no vault key), `auth` when they
   * cannot be decrypted. Never called by the dry-run adapter.
   */
  secrets(): Promise<ChannelCredentials>;
  /**
   * The public URL of the render. Live: copies it to the public bucket on first call
   * (`promoteToPublic`). Dry-run: a placeholder on the reserved `.invalid` domain; nothing is
   * copied.
   */
  getPublicVideoUrl(): Promise<string>;
  /** Likewise for the poster; null when the version has none. */
  getPublicPosterUrl(): Promise<string | null>;
  /** The caption composed and fitted to this platform's limits. */
  caption(): FittedCaption;
  /**
   * The `PublishRequest` for this post: account, public URLs, fitted caption and media facts.
   * Throws `PublishFailure` (`invalid_media`) when the render lacks a duration, and
   * (`not_configured`) for a live post on a channel without an account id.
   */
  publishRequest(): Promise<PublishRequest>;
  /**
   * Records what was sent and received on the attempt. Call it with the request before sending,
   * so a failed call still shows what was sent. Values are redacted before they are stored;
   * later calls replace the fields they pass.
   */
  record(part: { request?: JsonObject; response?: JsonObject }): void;
  /** Aborts when the task's lease is lost or the server stops; pass it to every request. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  now(): Date;
}

/** Something the platform would refuse; any issue fails the post as `invalid_media`. */
export interface AdapterIssue {
  field: string;
  message: string;
}

/** What `publish` returns. */
export interface PublishResult {
  /** The platform's id of the post, when already known. */
  externalId?: string;
  /** The upload or container id `status` needs. */
  containerId?: string;
  permalink?: string;
  /** True while the platform still processes the post; `status` is polled until it settles. */
  pending: boolean;
}

/** What `status` returns. */
export interface StatusResult {
  state: "pending" | "published" | "failed";
  permalink?: string;
  externalId?: string;
  /** Set when `state` is `failed`. */
  error?: PublishError;
}

/**
 * A platform adapter. Every method may throw `PublishFailure`; anything else counts as a
 * retryable `transient` failure.
 */
export interface PublisherAdapter {
  readonly platform: Platform;
  /** Checks the post before anything is sent. Must not call the network. */
  validate(context: PublishContext): Promise<AdapterIssue[]>;
  /** Sends the post (or, in dry-run, records what would be sent). */
  publish(context: PublishContext): Promise<PublishResult>;
  /** Asks the platform how a pending post is doing (and finishes it when it is ready). */
  status(context: PublishContext): Promise<StatusResult>;
}
