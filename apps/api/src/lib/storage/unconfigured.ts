import type { Storage } from "./types";

/** Thrown by every operation of storage that has no S3 settings. */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Object storage is not configured (S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY)");
    this.name = "StorageNotConfiguredError";
  }
}

/**
 * Storage for a server started without S3 settings, which only development and tests allow.
 * `configured` is false, so callers can refuse early; every operation throws.
 */
export function createUnconfiguredStorage(
  buckets: { bucket?: string; publicBucket?: string } = {},
): Storage {
  const fail = async (): Promise<never> => {
    throw new StorageNotConfiguredError();
  };
  return {
    configured: false,
    bucket: buckets.bucket ?? "",
    publicBucket: buckets.publicBucket ?? "",
    presignPut: fail,
    presignGet: fail,
    head: fail,
    getStream: fail,
    delete: fail,
    promoteToPublic: fail,
    publicUrl: () => {
      throw new StorageNotConfiguredError();
    },
  };
}
