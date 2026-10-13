import { createHash, randomBytes } from "node:crypto";
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StorageConfig } from "../src/lib/storage";
import { type FakeS3, startFakeS3 } from "./fake-s3";

/**
 * Where storage tests run. `TEST_S3` picks it: `auto` (default) uses the S3 endpoint
 * (`S3_ENDPOINT`, the local SeaweedFS by default) when it answers and the in-process fake
 * otherwise; `real` requires the endpoint (CI sets it); `fake` always uses the fake.
 */
export interface StorageTarget {
  kind: "s3" | "fake";
  config: StorageConfig;
  /** A plain S3 client with the same credentials, for planting objects and cleaning up. */
  client: S3Client;
  fake: FakeS3 | null;
  close(): Promise<void>;
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:59000";

/** The local stack's development keys (see infra/seaweedfs/s3.json), unless the env names others. */
function credentials(): { accessKeyId: string; secretAccessKey: string } {
  return {
    accessKeyId: process.env.S3_ACCESS_KEY ?? ["loomcast", "dev", "access"].join("-"),
    secretAccessKey: process.env.S3_SECRET_KEY ?? ["loomcast", "dev", "secret"].join("-"),
  };
}

export function storageConfigFor(
  endpoint: string,
  overrides: Partial<StorageConfig> = {},
): StorageConfig {
  const bucket = process.env.S3_BUCKET ?? "loomcast-media";
  const publicBucket = process.env.S3_PUBLIC_BUCKET ?? "loomcast-public";
  return {
    endpoint,
    region: process.env.S3_REGION ?? "auto",
    forcePathStyle: true,
    bucket,
    publicBucket,
    ...credentials(),
    publicBaseUrl: `${endpoint}/${publicBucket}`,
    ...overrides,
  };
}

export function rawClient(config: StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** True when something answers HTTP at `endpoint` within a second and a half. */
export async function endpointReachable(endpoint: string): Promise<boolean> {
  try {
    await fetch(`${endpoint}/`, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

async function requireBuckets(client: S3Client, config: StorageConfig): Promise<void> {
  for (const bucket of [config.bucket, config.publicBucket]) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      throw new Error(
        `Bucket ${bucket} is missing on ${config.endpoint}. Run the s3-init service ` +
          "(docker compose run --rm s3-init) or set TEST_S3=fake.",
        { cause: error },
      );
    }
  }
}

export async function resolveStorageTarget(): Promise<StorageTarget> {
  const mode = process.env.TEST_S3 ?? "auto";
  const endpoint = process.env.S3_ENDPOINT ?? DEFAULT_ENDPOINT;
  if (mode === "fake" || !(await endpointReachable(endpoint))) {
    if (mode === "real") {
      throw new Error(`TEST_S3=real but nothing answers at ${endpoint}`);
    }
    return fakeStorageTarget();
  }
  const config = storageConfigFor(endpoint);
  const client = rawClient(config);
  await requireBuckets(client, config);
  return { kind: "s3", config, client, fake: null, close: async () => client.destroy() };
}

/** The in-process fake, optionally as a store that neither checks nor records checksums. */
export async function fakeStorageTarget(
  options: { recordChecksums?: boolean } = {},
): Promise<StorageTarget> {
  const fake = await startFakeS3({ recordChecksums: options.recordChecksums ?? true });
  const config = storageConfigFor(fake.endpoint, {
    bucket: "loomcast-media",
    publicBucket: "loomcast-public",
    publicBaseUrl: `${fake.endpoint}/loomcast-public`,
  });
  const client = rawClient(config);
  return {
    kind: "fake",
    config,
    client,
    fake,
    close: async () => {
      client.destroy();
      await fake.close();
    },
  };
}

/** Random bytes of `size` and their hex SHA-256. */
export function randomFile(size: number): { bytes: Buffer; sha256: string } {
  const bytes = randomBytes(size);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** PUTs `body` to a presigned upload with exactly the headers it came with. */
export function putUpload(
  upload: { url: string; method: string; headers: Record<string, string> },
  body: Uint8Array,
): Promise<Response> {
  return fetch(upload.url, { method: upload.method, headers: upload.headers, body });
}

/** Writes an object straight to the store, bypassing presigned URLs (a misbehaving client). */
export async function plantObject(
  target: StorageTarget,
  key: string,
  body: Buffer,
  mime: string,
): Promise<void> {
  await target.client.send(
    new PutObjectCommand({
      Bucket: target.config.bucket,
      Key: key,
      Body: body,
      ContentType: mime,
      // The store records the checksum of what was really stored, as a buggy client would cause.
      ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
    }),
  );
}

/** Best-effort removal of objects a test left behind. */
export async function removeObjects(
  target: StorageTarget,
  bucket: string,
  keys: readonly string[],
): Promise<void> {
  await Promise.allSettled(
    keys.map((key) => target.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))),
  );
}
