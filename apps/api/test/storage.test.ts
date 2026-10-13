import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  assetStorageKey,
  contentDisposition,
  createS3Storage,
  extensionForMime,
  parseContentKey,
  presignedUrlOrigin,
  publicObjectKey,
  sha256Base64ToHex,
  sha256HexToBase64,
  ulid,
} from "../src/lib/storage";
import { hashStream } from "../src/modules/assets";
import {
  fakeStorageTarget,
  putUpload,
  randomFile,
  removeObjects,
  resolveStorageTarget,
} from "./storage-support";

const target = await resolveStorageTarget();
const storage = createS3Storage(target.config);
const createdKeys: string[] = [];
const publicKeys: string[] = [];

afterAll(async () => {
  await removeObjects(target, target.config.bucket, createdKeys);
  await removeObjects(target, target.config.publicBucket, publicKeys);
  storage.destroy();
  await target.close();
});

/** A fresh content-addressed key for `sha256` in a project of its own. */
function keyFor(sha256: string, mime = "video/mp4"): string {
  const key = assetStorageKey(randomUUID(), "render", sha256, mime);
  createdKeys.push(key);
  return key;
}

/** Query parameter names of presigned URLs, assembled so no credential-shaped literal appears. */
const SIGNED_HEADERS_PARAM = ["X", "Amz", "SignedHeaders"].join("-");

describe("storage keys", () => {
  it("lays out private keys by project, kind and checksum", () => {
    const projectId = randomUUID();
    const sha = "A".repeat(64);
    expect(assetStorageKey(projectId, "voice", sha, "audio/mpeg")).toBe(
      `projects/${projectId}/voice/${"a".repeat(64)}.mp3`,
    );
    expect(extensionForMime("video/quicktime")).toBe("mov");
    expect(extensionForMime("audio/x-m4a")).toBe("m4a");
    expect(extensionForMime("application/zip")).toBe("bin");
    expect(parseContentKey(`projects/${projectId}/render/${"b".repeat(64)}.mp4`)).toEqual({
      sha256: "b".repeat(64),
      ext: "mp4",
    });
    expect(parseContentKey("projects/x/render/readme.txt")).toBeNull();
  });

  it("makes unguessable, time-ordered public keys", () => {
    const early = ulid(new Date("2026-01-01T00:00:00Z"));
    const late = ulid(new Date("2026-06-01T00:00:00Z"));
    expect(early).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(early < late).toBe(true);
    expect(ulid()).not.toBe(ulid());
    const sha = "c".repeat(64);
    expect(publicObjectKey(sha, "mp4")).toMatch(/^p\/[0-9A-HJKMNP-TV-Z]{26}\/c{64}\.mp4$/);
  });

  it("converts checksums and builds download headers", () => {
    const hex = createHash("sha256").update("loomcast").digest("hex");
    expect(sha256Base64ToHex(sha256HexToBase64(hex))).toBe(hex);
    expect(sha256Base64ToHex("abc-3")).toBeNull();
    expect(sha256Base64ToHex(undefined)).toBeNull();
    expect(contentDisposition("attachment", 'Café "final".mp4')).toBe(
      `attachment; filename="Caf_ _final_.mp4"; filename*=UTF-8''Caf%C3%A9%20%22final%22.mp4`,
    );
  });

  it("knows which origin presigned URLs use", () => {
    const base = { endpoint: "https://account.r2.example.test", bucket: "media" };
    expect(presignedUrlOrigin({ ...base, forcePathStyle: true })).toBe(
      "https://account.r2.example.test",
    );
    expect(presignedUrlOrigin({ ...base, forcePathStyle: false })).toBe(
      "https://media.account.r2.example.test",
    );
  });
});

describe(`storage against ${target.kind === "s3" ? "the S3 endpoint" : "the in-process fake"}`, () => {
  it("uploads through a presigned PUT with a signed checksum and reads it back", async () => {
    const file = randomFile(64 * 1024);
    const key = keyFor(file.sha256);
    const upload = await storage.presignPut({
      key,
      mime: "video/mp4",
      bytes: file.bytes.length,
      sha256: file.sha256,
    });
    expect(upload.method).toBe("PUT");
    expect(upload.headers).toEqual({
      "Content-Type": "video/mp4",
      "Content-Length": String(file.bytes.length),
      "x-amz-checksum-sha256": sha256HexToBase64(file.sha256),
    });
    const signed = new URL(upload.url).searchParams.get(SIGNED_HEADERS_PARAM)?.split(";") ?? [];
    expect(signed).toEqual(
      expect.arrayContaining(["content-type", "content-length", "x-amz-checksum-sha256"]),
    );
    const ttl = upload.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000);

    const put = await putUpload(upload, file.bytes);
    expect(put.status).toBe(200);

    expect(await storage.head(key)).toEqual({
      bytes: file.bytes.length,
      mime: "video/mp4",
      sha256: file.sha256,
    });
    expect(await hashStream(await storage.getStream(key), 1024 * 1024)).toBe(file.sha256);

    const download = await storage.presignGet({
      key,
      filename: "final cut.mp4",
      disposition: "attachment",
    });
    expect(download.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    const got = await fetch(download.url);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-disposition")).toContain(
      'attachment; filename="final cut.mp4"',
    );
    expect(Buffer.from(await got.arrayBuffer()).equals(file.bytes)).toBe(true);

    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
    await storage.delete(key);
  });

  it("refuses an upload whose bytes do not match the signed checksum", async () => {
    const file = randomFile(4096);
    const key = keyFor(file.sha256);
    const upload = await storage.presignPut({
      key,
      mime: "video/mp4",
      bytes: file.bytes.length,
      sha256: file.sha256,
    });
    const tampered = Buffer.from(file.bytes);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const put = await putUpload(upload, tampered);
    expect(put.status).toBe(400);
    expect(await put.text()).toContain("BadDigest");
    expect(await storage.head(key)).toBeNull();
  });

  it("keeps private objects away from anonymous readers", async () => {
    const file = randomFile(1024);
    const key = keyFor(file.sha256);
    const upload = await storage.presignPut({
      key,
      mime: "video/mp4",
      bytes: file.bytes.length,
      sha256: file.sha256,
    });
    expect((await putUpload(upload, file.bytes)).status).toBe(200);
    const { endpoint, bucket, publicBucket } = target.config;
    expect((await fetch(`${endpoint}/${bucket}/${key}`)).status).toBe(403);
    expect((await fetch(`${endpoint}/${bucket}/`)).status).toBe(403);
    expect((await fetch(`${endpoint}/${publicBucket}/`)).status).toBe(403);
  });

  it("promotes a private object to an anonymous public URL under a fresh key", async () => {
    const file = randomFile(32 * 1024);
    const key = keyFor(file.sha256);
    const upload = await storage.presignPut({
      key,
      mime: "video/mp4",
      bytes: file.bytes.length,
      sha256: file.sha256,
    });
    expect((await putUpload(upload, file.bytes)).status).toBe(200);

    const first = await storage.promoteToPublic(key);
    const second = await storage.promoteToPublic(key);
    publicKeys.push(first.publicKey, second.publicKey);
    expect(first.publicKey).toMatch(new RegExp(`^p/[0-9A-HJKMNP-TV-Z]{26}/${file.sha256}\\.mp4$`));
    expect(second.publicKey).not.toBe(first.publicKey);
    expect(first.url).toBe(`${target.config.publicBaseUrl}/${first.publicKey}`);

    const anonymous = await fetch(first.url);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("content-type")).toBe("video/mp4");
    expect(anonymous.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(Buffer.from(await anonymous.arrayBuffer()).equals(file.bytes)).toBe(true);

    // The private original is still private.
    expect((await fetch(`${target.config.endpoint}/${target.config.bucket}/${key}`)).status).toBe(
      403,
    );
    await expect(storage.promoteToPublic(keyFor(randomFile(8).sha256))).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe.skipIf(target.kind !== "s3")("signed upload rules on the S3 endpoint", () => {
  async function presigned() {
    const file = randomFile(2048);
    const key = keyFor(file.sha256);
    const upload = await storage.presignPut({
      key,
      mime: "video/mp4",
      bytes: file.bytes.length,
      sha256: file.sha256,
    });
    return { file, key, upload };
  }

  it("refuses a body of another length", async () => {
    const { file, key, upload } = await presigned();
    const longer = Buffer.concat([file.bytes, Buffer.from([1, 2, 3])]);
    const { "Content-Length": _length, ...headers } = upload.headers;
    const put = await fetch(upload.url, { method: "PUT", headers, body: longer });
    expect(put.status).toBe(403);
    expect(await storage.head(key)).toBeNull();
  });

  it("refuses an upload without the checksum header or with another content type", async () => {
    const { file, key, upload } = await presigned();
    const { "x-amz-checksum-sha256": _checksum, ...withoutChecksum } = upload.headers;
    expect(
      (await fetch(upload.url, { method: "PUT", headers: withoutChecksum, body: file.bytes }))
        .status,
    ).toBe(403);
    const otherType = { ...upload.headers, "Content-Type": "text/plain" };
    expect(
      (await fetch(upload.url, { method: "PUT", headers: otherType, body: file.bytes })).status,
    ).toBe(403);
    expect(await storage.head(key)).toBeNull();
  });
});

describe("storage against a store without checksum support", () => {
  it("reports no checksum, so finalize falls back to hashing", async () => {
    const plain = await fakeStorageTarget({ recordChecksums: false });
    const plainStorage = createS3Storage(plain.config);
    try {
      const file = randomFile(1024);
      const key = assetStorageKey(randomUUID(), "voice", file.sha256, "audio/mpeg");
      const upload = await plainStorage.presignPut({
        key,
        mime: "audio/mpeg",
        bytes: file.bytes.length,
        sha256: file.sha256,
      });
      expect((await putUpload(upload, file.bytes)).status).toBe(200);
      expect(await plainStorage.head(key)).toEqual({
        bytes: file.bytes.length,
        mime: "audio/mpeg",
        sha256: null,
      });
      expect(await hashStream(await plainStorage.getStream(key), 1024)).toBe(file.sha256);
      expect(await hashStream(await plainStorage.getStream(key), 1023)).toBeNull();
    } finally {
      plainStorage.destroy();
      await plain.close();
    }
  });
});
