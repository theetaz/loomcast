import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  contentDisposition,
  parseContentKey,
  publicObjectKey,
  sha256Base64ToHex,
  sha256HexToBase64,
} from "./keys";
import type { PresignedGet, PresignedPut, Storage, StorageConfig, StoredObject } from "./types";

/** Lifetime of an upload URL. */
export const PRESIGN_PUT_TTL_SECONDS = 15 * 60;
/** Lifetime of a download URL. */
export const PRESIGN_GET_TTL_SECONDS = 60 * 60;

/** Headers signed into every upload URL, so the store refuses a different type, size or checksum. */
const SIGNED_UPLOAD_HEADERS = new Set(["content-type", "content-length", "x-amz-checksum-sha256"]);

/**
 * Promoted objects never change (their key is new every time), so caches and the CDN may keep them
 * for good.
 */
const PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface S3Storage extends Storage {
  /** Closes the client's sockets. */
  destroy(): void;
}

/**
 * The origin presigned URLs point at: the endpoint itself with path-style addressing, or
 * `<bucket>.<host>` with virtual-hosted addressing. The web app's CSP must allow it.
 */
export function presignedUrlOrigin(
  config: Pick<StorageConfig, "endpoint" | "forcePathStyle" | "bucket">,
): string {
  const endpoint = new URL(config.endpoint);
  if (!config.forcePathStyle) {
    endpoint.hostname = `${config.bucket}.${endpoint.hostname}`;
  }
  return endpoint.origin;
}

/** Encodes each segment of a key for the `x-amz-copy-source` header. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function isNotFound(error: unknown): boolean {
  const fields = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  return (
    fields !== null &&
    typeof fields === "object" &&
    (fields.name === "NotFound" ||
      fields.name === "NoSuchKey" ||
      fields.$metadata?.httpStatusCode === 404)
  );
}

/**
 * Storage on any S3-compatible service: Cloudflare R2 in production, SeaweedFS locally. The client
 * sends checksums only where an operation requires them; the default CRC32 trailers of current
 * SDKs are not understood by every S3-compatible store.
 */
export function createS3Storage(config: StorageConfig): S3Storage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const publicBase = config.publicBaseUrl.replace(/\/+$/, "");

  async function head(key: string, bucket = config.bucket): Promise<StoredObject | null> {
    try {
      const response = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }),
      );
      const wholeObject =
        response.ChecksumType === undefined || response.ChecksumType === "FULL_OBJECT";
      return {
        bytes: response.ContentLength ?? 0,
        mime: response.ContentType ?? null,
        sha256: wholeObject ? sha256Base64ToHex(response.ChecksumSHA256) : null,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  function publicUrl(publicKey: string): string {
    return `${publicBase}/${encodeKey(publicKey)}`;
  }

  return {
    configured: true,
    bucket: config.bucket,
    publicBucket: config.publicBucket,

    async presignPut({ key, mime, bytes, sha256 }): Promise<PresignedPut> {
      const checksum = sha256HexToBase64(sha256);
      const expiresAt = new Date(Date.now() + PRESIGN_PUT_TTL_SECONDS * 1000);
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ContentType: mime,
          ContentLength: bytes,
          ChecksumSHA256: checksum,
        }),
        {
          expiresIn: PRESIGN_PUT_TTL_SECONDS,
          signableHeaders: SIGNED_UPLOAD_HEADERS,
          // Kept as a header rather than a query parameter, so the store checks the body against it.
          unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
        },
      );
      return {
        url,
        method: "PUT",
        headers: {
          "Content-Type": mime,
          // Browsers set the length themselves; streaming clients must send it.
          "Content-Length": String(bytes),
          "x-amz-checksum-sha256": checksum,
        },
        expiresAt,
      };
    },

    async presignGet({ key, filename, disposition = "inline" }): Promise<PresignedGet> {
      const expiresAt = new Date(Date.now() + PRESIGN_GET_TTL_SECONDS * 1000);
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ...(filename === undefined
            ? {}
            : { ResponseContentDisposition: contentDisposition(disposition, filename) }),
        }),
        { expiresIn: PRESIGN_GET_TTL_SECONDS },
      );
      return { url, expiresAt };
    },

    head: (key) => head(key),

    async getStream(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      const body = response.Body;
      if (body instanceof Readable) {
        return body;
      }
      if (body !== undefined && "transformToWebStream" in body) {
        return Readable.fromWeb(
          body.transformToWebStream() as Parameters<typeof Readable.fromWeb>[0],
        );
      }
      throw new Error("The object store returned no body");
    },

    async delete(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    },

    async promoteToPublic(key) {
      const source = await head(key);
      if (source === null) {
        throw new Error("The object to promote does not exist");
      }
      const parsed = parseContentKey(key);
      const sha256 = parsed?.sha256 ?? source.sha256;
      if (sha256 === null) {
        throw new Error("The object to promote has no known SHA-256");
      }
      const publicKey = publicObjectKey(sha256, parsed?.ext ?? "mp4");
      await client.send(
        new CopyObjectCommand({
          Bucket: config.publicBucket,
          Key: publicKey,
          CopySource: `${config.bucket}/${encodeKey(key)}`,
          MetadataDirective: "REPLACE",
          ContentType: source.mime ?? "application/octet-stream",
          CacheControl: PUBLIC_CACHE_CONTROL,
        }),
      );
      return { publicKey, url: publicUrl(publicKey) };
    },

    publicUrl,

    destroy() {
      client.destroy();
    },
  };
}
