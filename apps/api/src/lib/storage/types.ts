import type { Readable } from "node:stream";

/** How the API reaches the S3-compatible object store (Cloudflare R2, or SeaweedFS locally). */
export interface StorageConfig {
  /** S3 API endpoint, for example `http://127.0.0.1:59000`. */
  endpoint: string;
  /** Signing region. R2 expects `auto`. */
  region: string;
  /** Path-style URLs (`<endpoint>/<bucket>/<key>`) instead of `<bucket>.<host>`. */
  forcePathStyle: boolean;
  /** Private bucket for every upload: drafts, voice takes, renders and reference media. */
  bucket: string;
  /** Publicly readable bucket that only ever holds promoted final renders. */
  publicBucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Base URL that serves `publicBucket` (a custom domain in production). */
  publicBaseUrl: string;
}

/** A presigned PUT. The client must send exactly `headers`; they are part of the signature. */
export interface PresignedPut {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface PresignedGet {
  url: string;
  expiresAt: Date;
}

export interface PresignPutInput {
  key: string;
  mime: string;
  /** Exact size; signed, so the store refuses any other length. */
  bytes: number;
  /** Lowercase hex SHA-256 of the bytes; signed and checked by the store when it supports it. */
  sha256: string;
}

export interface PresignGetInput {
  key: string;
  /** Download name. Sets `Content-Disposition` on the response. */
  filename?: string;
  /** Defaults to `inline`. */
  disposition?: "inline" | "attachment";
}

/** What a HEAD request reports about a stored object. */
export interface StoredObject {
  bytes: number;
  mime: string | null;
  /**
   * Lowercase hex SHA-256 the store computed and checked on upload, or null when the store did
   * not record a whole-object SHA-256 (the caller then hashes the bytes itself).
   */
  sha256: string | null;
}

export interface PromotedObject {
  /** Key in the public bucket: `p/<ulid>/<sha256>.<ext>`. */
  publicKey: string;
  /** Anonymous URL under `PUBLIC_BASE_URL`. */
  url: string;
}

/**
 * Object storage. Bytes never pass through the API: clients PUT to presigned URLs and read through
 * presigned GETs. Only `getStream` reads bytes server-side, to verify an upload whose checksum the
 * store did not record.
 */
export interface Storage {
  /** False when the server runs without S3 settings; every operation then throws. */
  readonly configured: boolean;
  /** The private bucket every asset lives in. */
  readonly bucket: string;
  readonly publicBucket: string;
  /** A 15-minute PUT URL with the content type, length and `x-amz-checksum-sha256` signed. */
  presignPut(input: PresignPutInput): Promise<PresignedPut>;
  /** A one-hour GET URL for a private object. */
  presignGet(input: PresignGetInput): Promise<PresignedGet>;
  /** The object's size, type and stored checksum, or null when there is no such object. */
  head(key: string): Promise<StoredObject | null>;
  /** The object's bytes. Throws when there is no such object. */
  getStream(key: string): Promise<Readable>;
  /** Deletes the object; succeeds when it is already gone. */
  delete(key: string): Promise<void>;
  /**
   * Copies a private object into the public bucket under an unguessable key and returns its
   * anonymous URL. Each call makes a new copy, so a URL can be withdrawn without touching others.
   */
  promoteToPublic(key: string): Promise<PromotedObject>;
  /** The anonymous URL of a key in the public bucket. */
  publicUrl(publicKey: string): string;
}
