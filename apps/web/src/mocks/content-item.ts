import {
  type ApiError,
  type AssetDetail,
  type AssetKind,
  AssetUrlQuerySchema,
  allowedActions,
  type ContentItem,
  type ContentVersion,
  type ContentVersionSummary,
  CreateReviewRequestSchema,
  EditVersionRequestSchema,
  findTransition,
  formatMediaIssues,
  isProducedFormat,
  isPublishable,
  mediaTypeOfMime,
  type PipelineState,
  type PostMediaEntry,
  REVIEW_DECISION_STATES,
  type Review,
  routes,
  SubmitContentRequestSchema,
  stageForArtifacts,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { z } from "zod";
import { activeJobs, runSingleStep, updateContentItem } from "./content";
import { mockConversation, mockJob } from "./conversations";
import { type MockDb, mockId, publish } from "./db";

// The item page's routes: versions, edits, reviews, the item conversation, assets and their
// presigned URLs. Media bytes are made up in the page: a quiet tone for voice takes, an SVG
// poster and a short clip recorded from a canvas for renders.

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");
const itemNotFound = () => apiError(404, "not_found", "No content item has that id.");
const assetNotFound = () => apiError(404, "not_found", "No asset has that id.");

function invalid(error: z.ZodError) {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return apiError(400, "validation_failed", `${where}${issue?.message ?? "Check the request."}`);
}

/** How long a mock presigned URL lasts, like the real one. */
export const MOCK_URL_TTL_MS = 60 * 60_000;

const HEX = "0123456789abcdef";

function randomHex(length: number): string {
  return Array.from({ length }, () => HEX[Math.floor(Math.random() * 16)]).join("");
}

const EXTENSIONS: Record<AssetKind, string> = {
  voice: "mp3",
  render: "mp4",
  poster: "jpg",
  frame: "png",
  reference_media: "mp4",
  other: "txt",
  media: "jpg",
};

const MIME_TYPES: Record<AssetKind, string> = {
  voice: "audio/mpeg",
  render: "video/mp4",
  poster: "image/jpeg",
  frame: "image/png",
  reference_media: "video/mp4",
  other: "text/plain",
  media: "image/jpeg",
};

/** A ready asset of an item, with plausible media facts for its kind. */
export function mockAsset(
  overrides: Partial<AssetDetail> & Pick<AssetDetail, "workspaceId" | "itemId" | "kind">,
): AssetDetail {
  const at = overrides.createdAt ?? new Date().toISOString();
  const kind = overrides.kind;
  const durationMs =
    overrides.durationMs !== undefined
      ? overrides.durationMs
      : kind === "voice" || kind === "render"
        ? 42_000
        : null;
  const visual = kind === "render" || kind === "poster" || kind === "frame";
  return {
    id: mockId(),
    status: "ready",
    filename: `${kind}-${randomHex(6)}.${EXTENSIONS[kind]}`,
    mime: MIME_TYPES[kind],
    bytes: kind === "render" ? 8_412_331 : kind === "voice" ? 672_480 : 184_220,
    sha256: randomHex(64),
    width: visual ? 1080 : null,
    height: visual ? 1920 : null,
    durationMs,
    probe:
      kind === "render"
        ? {
            durationMs: durationMs ?? undefined,
            width: 1080,
            height: 1920,
            fps: 30,
            videoCodec: "h264",
            audioCodec: "aac",
            bitRate: 1_602_000,
            sampleRate: 48_000,
            channels: 2,
            formatName: "mov,mp4,m4a,3gp,3g2,mj2",
          }
        : kind === "voice"
          ? {
              durationMs: durationMs ?? undefined,
              audioCodec: "mp3",
              sampleRate: 44_100,
              channels: 1,
            }
          : null,
    createdAt: at,
    finalizedAt: at,
    alignment: null,
    ...overrides,
  };
}

function versionsOf(db: MockDb, itemId: string): ContentVersion[] {
  return db.contentVersions
    .filter((version) => version.itemId === itemId)
    .sort((a, b) => a.versionNo - b.versionNo);
}

function summary(version: ContentVersion): ContentVersionSummary {
  const { script: _script, storyboard: _storyboard, caption: _caption, ...rest } = version;
  return rest;
}

/** Stores an asset for every voice, render and poster the item's versions point at. */
export function ensureItemAssets(db: MockDb, item: ContentItem) {
  for (const version of versionsOf(db, item.id)) {
    const files: [AssetKind, string | null][] = [
      ["voice", version.voiceAssetId],
      ["render", version.renderAssetId],
      ["poster", version.posterAssetId],
    ];
    for (const [kind, id] of files) {
      if (!id || db.assets.some((asset) => asset.id === id)) continue;
      const durationMs =
        kind === "voice"
          ? (version.script?.estimatedDurationMs ?? 42_000)
          : kind === "render"
            ? (item.durationMs ?? 42_000)
            : null;
      db.assets.push(
        mockAsset({
          id,
          kind,
          workspaceId: item.workspaceId,
          itemId: item.id,
          createdAt: version.createdAt,
          durationMs,
          filename: `${kind}-v${version.versionNo}.${EXTENSIONS[kind]}`,
        }),
      );
    }
    version.media.forEach((entry, index) => {
      if (db.assets.some((asset) => asset.id === entry.assetId)) return;
      const video = entry.type === "video";
      db.assets.push(
        mockAsset({
          id: entry.assetId,
          kind: "media",
          workspaceId: item.workspaceId,
          itemId: item.id,
          createdAt: version.createdAt,
          mime: video ? "video/mp4" : "image/jpeg",
          filename: `media-${index + 1}.${video ? "mp4" : "jpg"}`,
          width: 1080,
          height: item.format === "story" || video ? 1920 : 1350,
          durationMs: video ? 12_000 : null,
        }),
      );
    });
  }
}

function findAsset(db: MockDb, id: string): AssetDetail | undefined {
  const stored = db.assets.find((asset) => asset.id === id);
  if (stored) return stored;
  const version = db.contentVersions.find(
    (entry) =>
      entry.voiceAssetId === id ||
      entry.renderAssetId === id ||
      entry.posterAssetId === id ||
      entry.media.some((media) => media.assetId === id),
  );
  const item = version && db.contentItems.find((entry) => entry.id === version.itemId);
  if (!item) return undefined;
  ensureItemAssets(db, item);
  return db.assets.find((asset) => asset.id === id);
}

function publicAsset(asset: AssetDetail) {
  const { alignment: _alignment, ...rest } = asset;
  return rest;
}

/** Only artifacts changed by the edit: a caption or notes change keeps an approved or reviewed item. */
function onlyCaptionOrNotes(body: z.infer<typeof EditVersionRequestSchema>): boolean {
  return (
    body.script === undefined &&
    body.storyboard === undefined &&
    body.voiceAssetId === undefined &&
    body.format === undefined &&
    body.media === undefined
  );
}

/**
 * Why `media` can't go on a version of `item`, like the API: each entry a ready `media` (or
 * `render`) asset of the item, of the type it claims, at most once. Null when they fit.
 */
function mediaProblem(db: MockDb, item: ContentItem, media: readonly PostMediaEntry[]) {
  ensureItemAssets(db, item);
  const seen = new Set<string>();
  for (const [index, entry] of media.entries()) {
    const where = `media.${index}.assetId`;
    if (seen.has(entry.assetId)) return `${where}: The same file is in the post twice.`;
    seen.add(entry.assetId);
    const asset = db.assets.find((candidate) => candidate.id === entry.assetId);
    if (
      !asset ||
      asset.itemId !== item.id ||
      (asset.kind !== "media" && asset.kind !== "render") ||
      asset.status !== "ready"
    ) {
      return `${where}: Pick a ready photo or video of this item.`;
    }
    if (mediaTypeOfMime(asset.mime) !== entry.type) {
      return `${where}: The file is not a ${entry.type}.`;
    }
  }
  return null;
}

// Media bytes ------------------------------------------------------------------------------

/** A quiet, syllable-like tone as a mono 16-bit WAV, so voice takes play in mock mode. */
function toneWav(durationMs: number): ArrayBuffer {
  const sampleRate = 8_000;
  const samples = Math.floor((Math.min(durationMs, 60_000) / 1000) * sampleRate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const time = index / sampleRate;
    const envelope = Math.max(0, Math.sin(Math.PI * 4 * time)) ** 2;
    const value = Math.sin(2 * Math.PI * 196 * time) * envelope * 0.06;
    view.setInt16(44 + index * 2, Math.round(value * 32_767), true);
  }
  return buffer;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A 9:16 poster in the brand colours with the item's title. */
function posterSvg(title: string): string {
  const words = title.split(/\s+/);
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= 16)
      lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  const text = lines
    .slice(0, 6)
    .map(
      (line, index) =>
        `<text x="96" y="${760 + index * 118}" font-family="Georgia, serif" font-size="104" font-weight="700" fill="#f6f4ee">${escapeXml(line)}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a52d1"/><stop offset="1" stop-color="#1d1f4d"/></linearGradient></defs><rect width="1080" height="1920" fill="url(#g)"/><circle cx="880" cy="380" r="210" fill="#c2552a" opacity="0.9"/><text x="96" y="600" font-family="Helvetica, Arial, sans-serif" font-size="44" letter-spacing="6" fill="#f6f4ee" opacity="0.8">RUST IN 60 SECONDS</text>${text}</svg>`;
}

/** A photo for a composed post: the asset's shape in the brand colours, numbered. */
function photoSvg(title: string, asset: AssetDetail): string {
  const width = asset.width ?? 1080;
  const height = asset.height ?? 1350;
  const number = /media-(\d+)/.exec(asset.filename)?.[1] ?? "1";
  const hue = (Number(number) * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#1d1f4d"/><circle cx="${width * 0.7}" cy="${height * 0.35}" r="${width * 0.28}" fill="hsl(${hue} 55% 55%)" opacity="0.85"/><rect x="${width * 0.08}" y="${height * 0.62}" width="${width * 0.5}" height="${height * 0.06}" rx="12" fill="#4a52d1"/><text x="${width * 0.08}" y="${height * 0.82}" font-family="Georgia, serif" font-size="${width * 0.07}" fill="#f6f4ee">${escapeXml(title.slice(0, 22))}</text><text x="${width * 0.08}" y="${height * 0.12}" font-family="Helvetica, Arial, sans-serif" font-size="${width * 0.05}" fill="#c2552a">${number}</text></svg>`;
}

let demoVideo: Promise<Blob | null> | null = null;

/**
 * Mock mode: a two-second clip recorded from a canvas in the page, so the player has something to
 * play. Nothing is downloaded or stored. Resolves to null where recording is unavailable.
 */
function demoVideoClip(): Promise<Blob | null> {
  if (typeof document === "undefined" || typeof MediaRecorder === "undefined") {
    return Promise.resolve(null);
  }
  demoVideo ??= new Promise<Blob | null>((resolve) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 270;
      canvas.height = 480;
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(null);
        return;
      }
      const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
      let frame = 0;
      const draw = () => {
        const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, "#4a52d1");
        gradient.addColorStop(1, "#1d1f4d");
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#c2552a";
        context.beginPath();
        context.arc(60 + frame * 2.5, 120, 46, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = "#f6f4ee";
        context.font = "600 22px sans-serif";
        context.fillText("Mock preview", 24, 300);
        context.font = "14px monospace";
        context.fillText(`frame ${String(frame).padStart(2, "0")}`, 24, 330);
        frame += 1;
        if (frame >= 60) {
          clearInterval(timer);
          recorder.stop();
        }
      };
      recorder.start();
      draw();
      const timer = setInterval(draw, 1000 / 30);
    } catch {
      resolve(null);
    }
  });
  return demoVideo;
}

// Handlers -------------------------------------------------------------------------------

/** The routes of the item page, following `@loomcast/contracts`. */
export function createContentItemHandlers(db: MockDb) {
  const findItem = (id: string) => db.contentItems.find((item) => item.id === id);
  let signature = 0;

  return [
    http.get(path("content.versions.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const item = findItem(String(params.id));
      if (!item) return itemNotFound();
      const version = db.contentVersions.find(
        (entry) => entry.id === params.versionId && entry.itemId === item.id,
      );
      return version
        ? HttpResponse.json(version)
        : apiError(404, "not_found", "No version of this item has that id.");
    }),

    http.post(path("content.versions.edit"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const item = findItem(String(params.id));
      if (!item) return itemNotFound();
      const parsed = EditVersionRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      const body = parsed.data;
      if (body.baseVersionId !== item.currentVersionId) {
        return apiError(
          409,
          "conflict",
          "This video has a newer version than the one you edited. Reload it and try again.",
        );
      }
      if (activeJobs(db).has(item.id)) {
        return apiError(409, "job_in_progress", "Wait for the running job, or cancel it first.");
      }
      const base = db.contentVersions.find((entry) => entry.id === item.currentVersionId);
      if (!base) return itemNotFound();
      if (!allowedActions(item.state, "user", db.user.role, base).includes("edit")) {
        return apiError(409, "invalid_transition", "This video can't be edited in its state.");
      }

      const next: ContentVersion = {
        ...base,
        id: mockId(),
        versionNo: item.versionNo + 1,
        parentVersionId: base.id,
        createdVia: "ui",
        createdByUser: db.user.id,
        jobId: null,
        createdAt: new Date().toISOString(),
      };
      if (body.script !== undefined) {
        next.script = body.script;
        next.hasScript = true;
        next.voiceAssetId = null;
        next.renderAssetId = null;
        next.posterAssetId = null;
      }
      if (body.storyboard !== undefined) {
        next.storyboard = body.storyboard;
        next.hasStoryboard = true;
        next.renderAssetId = null;
        next.posterAssetId = null;
      }
      if (body.voiceAssetId !== undefined) {
        ensureItemAssets(db, item);
        const take = db.assets.find((asset) => asset.id === body.voiceAssetId);
        if (!take || take.itemId !== item.id || take.kind !== "voice" || take.status !== "ready") {
          return apiError(
            422,
            "validation_failed",
            "voiceAssetId: Pick a ready voice take of this item.",
          );
        }
        next.voiceAssetId = take.id;
        next.renderAssetId = null;
        next.posterAssetId = null;
      }
      if (body.format !== undefined) next.format = body.format;
      if (body.media !== undefined) {
        const problem = mediaProblem(db, item, body.media);
        if (problem) return apiError(422, "validation_failed", problem);
        next.media = body.media;
      }
      if (body.caption !== undefined) next.caption = body.caption;
      if (body.notes !== undefined) next.notes = body.notes;

      const keepState =
        onlyCaptionOrNotes(body) && (item.state === "review" || item.state === "approved");
      const state: PipelineState = keepState ? item.state : stageForArtifacts(next);
      if (!findTransition({ from: item.state, to: state, actor: "user", version: next })) {
        return apiError(409, "invalid_transition", "That change is not allowed in this state.");
      }

      db.contentVersions.push(next);
      publish(db, {
        type: "content.version.created",
        payload: { workspaceId: item.workspaceId, version: summary(next) },
      });
      const updated = updateContentItem(db, item.id, (entry) => {
        entry.state = state;
        entry.currentVersionId = next.id;
        entry.versionNo = next.versionNo;
        entry.format = next.format;
        entry.durationMs = next.renderAssetId ? entry.durationMs : null;
        entry.posterAssetId = next.posterAssetId;
      });
      return HttpResponse.json({ item: updated, version: next }, { status: 201 });
    }),

    // Sends the current version to review: a render, or a composed post whose media fit.
    http.post(path("content.submit"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const item = findItem(String(params.id));
      if (!item) return itemNotFound();
      const parsed = SubmitContentRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      if (parsed.data.versionId !== item.currentVersionId) {
        return apiError(409, "conflict", "A newer version arrived. Look at it before sending it.");
      }
      if (item.state === "review") return HttpResponse.json({ ...item });
      const version = db.contentVersions.find((entry) => entry.id === item.currentVersionId);
      if (
        !findTransition({ from: item.state, to: "review", via: "submit", actor: "user", version })
      ) {
        return apiError(409, "invalid_transition", "It isn't ready for review yet.");
      }
      const updated = updateContentItem(db, item.id, (entry) => {
        entry.state = "review";
      });
      return HttpResponse.json(updated);
    }),

    http.post(path("content.conversation"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const item = findItem(String(params.id));
      if (!item) return itemNotFound();
      let conversation = db.conversations.find((entry) => entry.contentItemId === item.id);
      if (!conversation) {
        conversation = mockConversation({
          workspaceId: item.workspaceId,
          createdBy: db.user.id,
          title: item.title,
          contentItemId: item.id,
        });
        db.conversations.push(conversation);
      }
      return HttpResponse.json(conversation);
    }),

    http.get(path("content.assets"), ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const item = findItem(String(params.id));
      if (!item) return itemNotFound();
      const kind = new URL(request.url).searchParams.get("kind");
      ensureItemAssets(db, item);
      const items = db.assets
        .filter((asset) => asset.itemId === item.id && (!kind || asset.kind === kind))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .map(publicAsset);
      return HttpResponse.json({ items });
    }),

    http.get(path("assets.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const asset = findAsset(db, String(params.id));
      return asset ? HttpResponse.json(asset) : assetNotFound();
    }),

    http.get(path("assets.url"), ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const asset = findAsset(db, String(params.id));
      if (!asset) return assetNotFound();
      if (asset.status !== "ready") {
        return apiError(409, "not_ready", "The file is still being uploaded or checked.");
      }
      const url = new URL(request.url);
      const query = AssetUrlQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      const disposition = query.success ? (query.data.disposition ?? "inline") : "inline";
      signature += 1;
      return HttpResponse.json({
        url: `${url.origin}/mock-media/${asset.id}?disposition=${disposition}&sig=${signature}`,
        expiresAt: new Date(Date.now() + MOCK_URL_TTL_MS).toISOString(),
      });
    }),

    http.get("*/mock-media/:id", async ({ params }) => {
      const asset = db.assets.find((entry) => entry.id === params.id);
      if (!asset) return new HttpResponse(null, { status: 404 });
      if (asset.kind === "voice") {
        return HttpResponse.arrayBuffer(toneWav(asset.durationMs ?? 10_000), {
          headers: { "Content-Type": "audio/wav" },
        });
      }
      if (asset.kind === "poster") {
        const item = db.contentItems.find((entry) => entry.id === asset.itemId);
        return new HttpResponse(posterSvg(item?.title ?? "Loomcast"), {
          headers: { "Content-Type": "image/svg+xml" },
        });
      }
      if (asset.kind === "media" && asset.mime.startsWith("image/")) {
        const item = db.contentItems.find((entry) => entry.id === asset.itemId);
        return new HttpResponse(photoSvg(item?.title ?? "Loomcast", asset), {
          headers: { "Content-Type": "image/svg+xml" },
        });
      }
      if (asset.kind === "render" || asset.kind === "media") {
        const clip = await demoVideoClip();
        if (clip) {
          return HttpResponse.arrayBuffer(await clip.arrayBuffer(), {
            headers: { "Content-Type": "video/webm" },
          });
        }
      }
      return new HttpResponse(null, { status: 404 });
    }),

    http.get(path("reviews.list"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const item = findItem(String(params.id));
      if (!item) return itemNotFound();
      const items = db.reviews
        .filter((review) => review.itemId === item.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return HttpResponse.json({ items });
    }),

    http.post(path("reviews.create"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const item = findItem(String(params.id));
      if (!item) return itemNotFound();
      const parsed = CreateReviewRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      const body = parsed.data;
      if (item.state !== "review") {
        return apiError(409, "invalid_transition", "Only a video in review can be decided.");
      }
      if (body.versionId !== item.currentVersionId) {
        return apiError(409, "conflict", "A newer version arrived. Look at it before deciding.");
      }
      const version = db.contentVersions.find((entry) => entry.id === body.versionId);
      // Like the API: a studio video needs its render, a composed post the media its format takes.
      if (body.decision === "approve" && !(version && isPublishable(version))) {
        return isProducedFormat(version?.format) && !version?.media.length
          ? apiError(422, "missing_artifact", "Only a rendered version can be approved.")
          : apiError(422, "missing_artifact", version ? formatMediaIssues(version).join(" ") : "");
      }
      const enqueueRevision = body.decision === "request_changes" && body.enqueueRevision !== false;
      const review: Review = {
        id: mockId(),
        itemId: item.id,
        versionId: body.versionId,
        decision: body.decision,
        comment: body.comment || null,
        enqueueRevision,
        userId: db.user.id,
        actorKind: "user",
        createdAt: new Date().toISOString(),
      };
      db.reviews.push(review);
      publish(db, { type: "review.created", payload: { workspaceId: item.workspaceId, review } });
      const updated = updateContentItem(db, item.id, (entry) => {
        entry.state = REVIEW_DECISION_STATES[body.decision];
        if (body.decision === "reject") entry.archivedAt = new Date().toISOString();
      });
      if (enqueueRevision) {
        const job = mockJob({
          workspaceId: item.workspaceId,
          conversationId: null,
          type: "content.revise",
          maxAttempts: 3,
        });
        db.jobs.push(job);
        activeJobs(db).set(item.id, job.id);
        publish(db, { type: "job.updated", payload: { job } });
        if (db.simulateProducer) runSingleStep(db, item.id, job.id, "revise");
      }
      return HttpResponse.json({ review, item: updated }, { status: 201 });
    }),
  ];
}

// Demo data -------------------------------------------------------------------------------

/**
 * Mock mode: every item with a voice gets an earlier take to choose from, and the item waiting
 * longest in review has a request for changes on an earlier version.
 */
export function seedItemDemo(db: MockDb, now = Date.now()) {
  for (const item of db.contentItems) {
    const current = db.contentVersions.find((version) => version.id === item.currentVersionId);
    if (!current?.voiceAssetId) continue;
    ensureItemAssets(db, item);
    db.assets.push(
      mockAsset({
        kind: "voice",
        workspaceId: item.workspaceId,
        itemId: item.id,
        filename: "voice-take-slower.mp3",
        durationMs: 47_500,
        createdAt: new Date(Date.parse(current.createdAt) - 40 * 60_000).toISOString(),
      }),
    );
  }
  const waiting = db.contentItems
    .filter((item) => item.state === "review")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
  const earlier = waiting && versionsOf(db, waiting.id).at(-2);
  if (waiting && earlier) {
    db.reviews.push({
      id: mockId(),
      itemId: waiting.id,
      versionId: earlier.id,
      decision: "request_changes",
      comment: "The hook takes too long. Open on the panic message, then explain.",
      enqueueRevision: true,
      userId: db.user.id,
      actorKind: "user",
      createdAt: new Date(now - 5 * 60 * 60_000).toISOString(),
    });
  }
}
