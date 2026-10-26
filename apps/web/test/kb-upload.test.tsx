import { createHash } from "node:crypto";
import type { UploadInstructions } from "@loomcast/contracts";
import { routes } from "@loomcast/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkReferenceFile,
  isAbortError,
  putFile,
  REFERENCE_MEDIA_MAX_BYTES,
  RIGHTS_NOTICE,
  referenceMediaMime,
  StorageUploadError,
  sha256OfFile,
  type UploadProgress,
  uploadFilename,
  uploadReferenceMedia,
} from "@/features/kb/media-upload";
import { overallShare } from "@/features/kb/ReferenceMediaUpload";
import type { MockDb } from "@/mocks/db";
import { createHandlers } from "@/mocks/handlers";
import { mockUploads } from "@/mocks/uploads";
import { kbSetup, recordRequests, WORKSPACE_SLUG } from "./support/kb";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";
import { server } from "./support/server";

/** Bytes that look nothing like a credential: a repeating ramp. */
function bytes(length: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, index) => (index * 7) % 251);
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function mediaFile(length = 4096, name = "reference.mp4", type = "video/mp4"): File {
  return new File([bytes(length)], name, { type });
}

/**
 * An `XMLHttpRequest` stand-in. Every PUT it receives is kept; `behaviour` decides the answer.
 * By default it reports upload progress in quarters, tells the mock store the bytes arrived and
 * answers 200.
 */
class FakeXhr {
  static sent: FakeXhr[] = [];
  static db: MockDb | null = null;
  static behaviour: (xhr: FakeXhr) => void = (xhr) => xhr.complete();

  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.body = body;
    FakeXhr.sent.push(this);
    queueMicrotask(() => FakeXhr.behaviour(this));
  }

  abort() {
    this.onabort?.();
  }

  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true } as ProgressEvent);
  }

  /** Stores the upload in the mock object store and answers 200 after progress events. */
  complete(store = true) {
    const total = (this.body as Blob).size;
    for (const quarter of [1, 2, 3, 4]) this.progress((total * quarter) / 4, total);
    const id = this.url.split("/").at(-1) ?? "";
    if (FakeXhr.db && store) mockUploads(FakeXhr.db).add(id);
    this.respond(200);
  }

  respond(status: number) {
    this.status = status;
    this.onload?.();
  }

  static reset(db: MockDb | null = null) {
    FakeXhr.sent = [];
    FakeXhr.db = db;
    FakeXhr.behaviour = (xhr) => xhr.complete();
  }
}

const createXhr = () => new FakeXhr() as unknown as XMLHttpRequest;

const INSTRUCTIONS: UploadInstructions = {
  url: "http://localhost/mock-storage/upload-1",
  method: "PUT",
  headers: {
    "Content-Type": "video/mp4",
    "Content-Length": "4096",
    "x-amz-checksum-sha256": "checksum-header-value",
  },
  expiresAt: "2026-10-13T10:00:00.000Z",
};

afterEach(() => {
  FakeXhr.reset();
  vi.unstubAllGlobals();
});

describe("reference media checks", () => {
  it("takes video and audio up to 1 GiB, by type or by extension", () => {
    expect(REFERENCE_MEDIA_MAX_BYTES).toBe(1024 ** 3);
    expect(checkReferenceFile({ name: "clip.mp4", type: "video/mp4", size: 10 })).toBeNull();
    expect(checkReferenceFile({ name: "clip.mov", type: "", size: 10 })).toBeNull();
    expect(referenceMediaMime({ name: "clip.MOV", type: "" })).toBe("video/quicktime");
    expect(checkReferenceFile({ name: "voice.m4a", type: "audio/x-m4a", size: 10 })).toBeNull();
    expect(
      checkReferenceFile({ name: "big.mp4", type: "video/mp4", size: REFERENCE_MEDIA_MAX_BYTES }),
    ).toBeNull();
    expect(
      checkReferenceFile({
        name: "big.mp4",
        type: "video/mp4",
        size: REFERENCE_MEDIA_MAX_BYTES + 1,
      }),
    ).toBe("That file is over 1 GiB, the most you can upload.");
    expect(checkReferenceFile({ name: "still.png", type: "image/png", size: 10 })).toMatch(
      /^Choose an MP4 or MOV video/,
    );
    expect(checkReferenceFile({ name: "empty.mp4", type: "video/mp4", size: 0 })).toBe(
      "That file is empty.",
    );
  });

  it("keeps file names the API accepts", () => {
    expect(uploadFilename("my clip.mp4")).toBe("my clip.mp4");
    expect(uploadFilename("../../etc/clip.mp4")).toBe(".._.._etc_clip.mp4");
    expect(uploadFilename("a\u0007b.mp4")).toBe("a_b.mp4");
    expect(uploadFilename("x".repeat(300))).toHaveLength(255);
  });
});

describe("incremental checksum", () => {
  it("hashes in slices to the same SHA-256 as the whole file, reporting progress", async () => {
    const data = bytes(10_000);
    const progress: number[] = [];
    const digest = await sha256OfFile(new Blob([data]), {
      chunkBytes: 4096,
      onProgress: (share) => progress.push(share),
    });
    expect(digest).toBe(sha256(data));
    expect(progress).toEqual([4096 / 10_000, 8192 / 10_000, 1]);
  });

  it("falls back to Web Crypto where WebAssembly is blocked", async () => {
    const data = bytes(5000);
    const progress: number[] = [];
    const digest = await sha256OfFile(new Blob([data]), {
      hasher: null,
      onProgress: (share) => progress.push(share),
    });
    expect(digest).toBe(sha256(data));
    expect(progress).toEqual([1]);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      sha256OfFile(new Blob([bytes(100)]), { signal: controller.signal }),
    ).rejects.toSatisfy(isAbortError);
  });
});

describe("presigned PUT", () => {
  it("sends the file with the signed headers and reports progress", async () => {
    const progress: number[] = [];
    const file = mediaFile();
    await putFile(INSTRUCTIONS, file, { createXhr, onProgress: (share) => progress.push(share) });
    const [xhr] = FakeXhr.sent;
    expect(xhr?.method).toBe("PUT");
    expect(xhr?.url).toBe(INSTRUCTIONS.url);
    expect(xhr?.body).toBe(file);
    // The browser sets Content-Length itself and refuses it from scripts.
    expect(xhr?.headers).toEqual({
      "Content-Type": "video/mp4",
      "x-amz-checksum-sha256": "checksum-header-value",
    });
    expect(progress).toEqual([0.25, 0.5, 0.75, 1, 1]);
  });

  it("fails on a refused upload and on a dropped connection", async () => {
    FakeXhr.behaviour = (xhr) => xhr.respond(403);
    await expect(putFile(INSTRUCTIONS, mediaFile(), { createXhr })).rejects.toMatchObject({
      name: "StorageUploadError",
      status: 403,
    });
    FakeXhr.behaviour = (xhr) => xhr.onerror?.();
    await expect(putFile(INSTRUCTIONS, mediaFile(), { createXhr })).rejects.toBeInstanceOf(
      StorageUploadError,
    );
  });

  it("aborts when cancelled", async () => {
    const controller = new AbortController();
    FakeXhr.behaviour = () => controller.abort();
    await expect(
      putFile(INSTRUCTIONS, mediaFile(), { createXhr, signal: controller.signal }),
    ).rejects.toSatisfy(isAbortError);
  });
});

describe("uploading reference media", () => {
  function setup() {
    const kb = kbSetup();
    server.use(...createHandlers(kb.db));
    FakeXhr.reset(kb.db);
    return kb;
  }

  it("hashes, uploads, finalizes, attaches and analyzes, in that order", async () => {
    const { db, reference } = setup();
    const requests = recordRequests();
    const file = mediaFile(6000);
    const stages: UploadProgress[] = [];
    const loadedAt = reference.updatedAt;

    const result = await uploadReferenceMedia(file, reference, {
      createXhr,
      onProgress: (progress) => stages.push(progress),
    });

    const create = requests.find((request) => request.path === "/api/assets/uploads");
    expect(create?.body).toEqual({
      workspaceId: reference.workspaceId,
      kind: "reference_media",
      filename: "reference.mp4",
      mime: "video/mp4",
      bytes: 6000,
      sha256: sha256(bytes(6000)),
    });
    expect(FakeXhr.sent).toHaveLength(1);
    expect(FakeXhr.sent[0]?.headers["x-amz-checksum-sha256"]).toBe(
      createHash("sha256").update(bytes(6000)).digest("base64"),
    );
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /api/assets/uploads",
      `POST /api/assets/${result.asset.id}/finalize`,
      `PATCH /api/kb/${reference.id}`,
      `POST /api/kb/${reference.id}/analyze`,
    ]);
    expect(requests[2]?.body).toEqual({
      expectedUpdatedAt: loadedAt,
      mediaAssetId: result.asset.id,
    });

    expect(result.asset.status).toBe("ready");
    expect(result.entry.reference?.mediaAssetId).toBe(result.asset.id);
    expect(result.job?.type).toBe("kb.analyze_reference");
    expect(db.kbEntries.find((entry) => entry.id === reference.id)?.reference?.analysisStatus).toBe(
      "queued",
    );

    const order = [...new Set(stages.map((progress) => progress.stage))];
    expect(order).toEqual(["checksum", "upload", "verify", "attach", "analyze", "done"]);
    const uploadShares = stages
      .filter((progress) => progress.stage === "upload")
      .map((progress) => progress.share);
    expect(uploadShares).toEqual([0, 0.25, 0.5, 0.75, 1, 1]);
    const overall = stages.map(overallShare);
    expect(overall).toEqual([...overall].sort((a, b) => a - b));
    expect(overall.at(-1)).toBe(1);
  });

  it("skips the PUT when the workspace already has the same file", async () => {
    const { reference } = setup();
    const first = await uploadReferenceMedia(mediaFile(), reference, { createXhr });
    const again = await uploadReferenceMedia(mediaFile(), first.entry, { createXhr });
    expect(FakeXhr.sent).toHaveLength(1);
    expect(again.asset.id).toBe(first.asset.id);
  });

  it("uploads again when storage never received the bytes", async () => {
    const { reference } = setup();
    let attempts = 0;
    FakeXhr.behaviour = (xhr) => {
      attempts += 1;
      xhr.complete(attempts > 1);
    };
    const result = await uploadReferenceMedia(mediaFile(), reference, { createXhr });
    expect(FakeXhr.sent).toHaveLength(2);
    expect(result.asset.status).toBe("ready");
  });

  it("re-reads the reference once when it changed meanwhile", async () => {
    const { reference } = setup();
    const stale = { ...reference, updatedAt: "2026-01-01T00:00:00.000Z" };
    const result = await uploadReferenceMedia(mediaFile(), stale, { createXhr });
    expect(result.entry.reference?.mediaAssetId).toBe(result.asset.id);
  });

  it("refuses files the API would refuse without contacting it", async () => {
    const { reference } = setup();
    const requests = recordRequests();
    await expect(
      uploadReferenceMedia(mediaFile(10, "still.png", "image/png"), reference, { createXhr }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(requests).toEqual([]);
  });
});

describe("reference media upload on the reference page", () => {
  it("shows the rights notice, uploads with progress and starts the analysis", async () => {
    const { db, reference } = kbSetup();
    FakeXhr.reset(db);
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    let release: () => void = () => {};
    FakeXhr.behaviour = (xhr) => {
      xhr.progress(1024, 4096);
      release = () => xhr.complete();
    };
    const stream = fakeStream(db);
    const { user, container } = renderApp(`/w/${WORKSPACE_SLUG}/kb/${reference.id}`, db, [], {
      createEventSource: stream.factory,
    });

    const media = await screen.findByRole("region", { name: "Media" }, { timeout: 5000 });
    expect(within(media).getByText(RIGHTS_NOTICE)).toBeInTheDocument();
    expect(RIGHTS_NOTICE).toBe("Only upload media you own or have permission to use.");

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("No file input");
    expect(input).toHaveAccessibleDescription(RIGHTS_NOTICE);
    await user.upload(input, mediaFile(4096, "my-reel.mp4"));

    const bar = await within(media).findByRole("progressbar", { name: "Upload progress" });
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "45"));
    expect(within(media).getByText("Uploading")).toBeInTheDocument();
    expect(within(media).getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    release();
    expect(await screen.findByText("Media uploaded")).toBeInTheDocument();
    expect(await within(media).findByText("my-reel.mp4")).toBeInTheDocument();
    expect(within(media).getByRole("button", { name: "Replace media" })).toBeInTheDocument();
    expect(await screen.findByText("Queued")).toBeInTheDocument();
  });

  it("says why a file can't be uploaded", async () => {
    const { db, reference } = kbSetup();
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const { container } = renderApp(`/w/${WORKSPACE_SLUG}/kb/${reference.id}`, db);
    const media = await screen.findByRole("region", { name: "Media" }, { timeout: 5000 });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("No file input");
    // `user.upload` honours `accept`; a drop or an odd picker can still hand over anything.
    Object.defineProperty(input, "files", {
      value: [mediaFile(10, "still.png", "image/png")],
      configurable: true,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(await within(media).findByRole("alert")).toHaveTextContent(
      /^Choose an MP4 or MOV video/,
    );
    expect(FakeXhr.sent).toEqual([]);
  });

  it("shows what storage answered when the upload fails", async () => {
    const { db, reference } = kbSetup();
    FakeXhr.reset(db);
    FakeXhr.behaviour = (xhr) => xhr.respond(403);
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const override = http.post(`*${routes["kb.analyze"].path}`, () =>
      HttpResponse.json({ error: { code: "internal", message: "unexpected" } }, { status: 500 }),
    );
    const { user, container } = renderApp(`/w/${WORKSPACE_SLUG}/kb/${reference.id}`, db, [
      override,
    ]);
    const media = await screen.findByRole("region", { name: "Media" }, { timeout: 5000 });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("No file input");
    await user.upload(input, mediaFile());
    expect(await within(media).findByRole("alert")).toHaveTextContent(
      "Storage refused the upload. Try again in a moment.",
    );
    expect(within(media).getByRole("button", { name: "Upload media" })).toBeInTheDocument();
  });
});
