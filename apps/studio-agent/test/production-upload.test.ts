import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlatformError } from "../src/production/platform";
import { assetProbe, downloadFile, sha256OfFile, uploadFile } from "../src/production/upload";
import {
  contentItem,
  contentVersion,
  FakePlatform,
  fakeStore,
  itemId,
  tempDir,
} from "./production-fakes";

function setup(failures: number[] = []) {
  const dir = tempDir("loomcast-upload-");
  const path = join(dir, "voice.mp3");
  const bytes = Buffer.from("x".repeat(70_000));
  writeFileSync(path, bytes);
  const platform = new FakePlatform({
    item: contentItem(),
    version: contentVersion(),
    format: null,
  });
  const store = fakeStore(platform, failures);
  const sleeps: number[] = [];
  const options = {
    platform,
    itemId,
    kind: "voice" as const,
    path,
    mime: "audio/mpeg" as const,
    signal: new AbortController().signal,
    fetch: store.fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return { dir, path, bytes, platform, store, sleeps, options };
}

describe("content-addressed uploads", () => {
  it("hashes while streaming, PUTs exactly the signed headers with duplex half, then finalizes", async () => {
    const { bytes, platform, store, options } = setup();
    const result = await uploadFile({ ...options, probe: { durationMs: 1_000 } });

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(platform.toolCalls("content.upload_asset")).toEqual([
      {
        itemId,
        kind: "voice",
        filename: "voice.mp3",
        mime: "audio/mpeg",
        bytes: bytes.length,
        sha256,
      },
    ]);
    expect(store.requests).toHaveLength(1);
    const [put] = store.requests;
    expect(put?.method).toBe("PUT");
    expect(put?.duplex).toBe("half");
    expect(put?.bytes).toBe(bytes.length);
    expect(put?.headers).toEqual({
      "content-type": "audio/mpeg",
      "content-length": String(bytes.length),
      "x-amz-checksum-sha256": Buffer.from(sha256, "hex").toString("base64"),
    });
    expect(platform.toolCalls("content.finalize_asset")).toEqual([
      { assetId: result.asset.id, probe: { durationMs: 1_000 } },
    ]);
    expect(result.uploaded).toBe(true);
    expect(result.asset.status).toBe("ready");
  });

  it("skips the PUT and finalize when the server already has the file", async () => {
    const { platform, store, options } = setup();
    const first = await uploadFile(options);
    const second = await uploadFile(options);
    expect(second).toEqual({ asset: first.asset, uploaded: false });
    expect(store.requests).toHaveLength(1);
    expect(platform.toolCalls("content.finalize_asset")).toHaveLength(1);
  });

  it("retries network errors and 5xx answers up to three attempts", async () => {
    const { store, sleeps, options } = setup([0, 503]);
    const result = await uploadFile(options);
    expect(result.asset.status).toBe("ready");
    expect(store.requests).toHaveLength(3);
    expect(sleeps).toEqual([500, 1_000]);
  });

  it("gives up after three failed attempts", async () => {
    const { platform, store, options } = setup([500, 502, 503]);
    await expect(uploadFile(options)).rejects.toMatchObject({
      name: "TransferError",
      retryable: true,
    });
    expect(store.requests).toHaveLength(3);
    expect(platform.toolCalls("content.finalize_asset")).toEqual([]);
  });

  it("does not retry a refused upload", async () => {
    const { store, options } = setup([403]);
    await expect(uploadFile(options)).rejects.toMatchObject({
      name: "TransferError",
      retryable: false,
    });
    expect(store.requests).toHaveLength(1);
  });

  it("repeats the PUT when the server reports the upload missing", async () => {
    const { platform, store, options } = setup();
    platform.missingOnFinalize = 1;
    const result = await uploadFile(options);
    expect(result.asset.status).toBe("ready");
    expect(store.requests).toHaveLength(2);
    expect(platform.toolCalls("content.finalize_asset")).toHaveLength(2);
  });

  it("stops when the upload stays missing", async () => {
    const { platform, options } = setup();
    platform.missingOnFinalize = 5;
    await expect(uploadFile(options)).rejects.toBeInstanceOf(PlatformError);
    expect(platform.toolCalls("content.finalize_asset")).toHaveLength(3);
  });

  it("streams a file's SHA-256", async () => {
    const { path, bytes } = setup();
    expect(await sha256OfFile(path)).toEqual({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  });

  it("maps a media probe to the asset probe", () => {
    expect(
      assetProbe({
        durationMs: 9_010,
        sizeBytes: 10,
        formatName: "mov,mp4",
        video: { codec: "h264", width: 1080, height: 1920, fps: 30 },
        audio: { codec: "aac", sampleRate: 48_000, channels: 2, bitRate: 128_000 },
      }),
    ).toEqual({
      formatName: "mov,mp4",
      durationMs: 9_010,
      width: 1080,
      height: 1920,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      sampleRate: 48_000,
      channels: 2,
      bitRate: 128_000,
    });
  });
});

describe("downloads", () => {
  it("downloads to the path when the checksum matches", async () => {
    const { dir, platform, store } = setup();
    const bytes = Buffer.from("stored voice");
    platform.addReadyAsset("7cd39ef0-f4b1-4d8f-80a2-9b8e1fb0d1e7", "voice", bytes);
    const target = join(dir, "out", "voice.mp3");
    const result = await downloadFile({
      url: "http://store.test/7cd39ef0-f4b1-4d8f-80a2-9b8e1fb0d1e7",
      path: target,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signal: new AbortController().signal,
      fetch: store.fetch,
      sleep: async () => {},
    });
    expect(result.bytes).toBe(bytes.length);
    expect(readFileSync(target)).toEqual(bytes);
  });

  it("removes a download that does not match its checksum", async () => {
    const { dir, platform, store } = setup();
    platform.addReadyAsset(
      "7cd39ef0-f4b1-4d8f-80a2-9b8e1fb0d1e7",
      "voice",
      Buffer.from("tampered"),
    );
    const target = join(dir, "voice-2.mp3");
    await expect(
      downloadFile({
        url: "http://store.test/7cd39ef0-f4b1-4d8f-80a2-9b8e1fb0d1e7",
        path: target,
        sha256: "0".repeat(64),
        signal: new AbortController().signal,
        fetch: store.fetch,
        sleep: async () => {},
        attempts: 2,
      }),
    ).rejects.toMatchObject({ name: "TransferError" });
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith(".part"))).toEqual([]);
  });
});
