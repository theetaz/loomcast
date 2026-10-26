import {
  type ApiError,
  type AssetDetail,
  CreateUploadRequestSchema,
  routes,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { z } from "zod";
import { type MockDb, mockId, publish } from "./db";

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

/** Where the mock "object store" takes PUTs. */
export const MOCK_STORAGE_PATH = "/mock-storage";

function apiError(status: number, code: string, message: string, details?: unknown) {
  return HttpResponse.json<ApiError>(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");

function invalid(error: z.ZodError) {
  return apiError(
    400,
    "validation_failed",
    "The request is not valid.",
    error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );
}

const uploadsByDb = new WeakMap<MockDb, Set<string>>();

/** Ids of pending assets whose bytes the pretend object store received. Tests may add to it. */
export function mockUploads(db: MockDb): Set<string> {
  let uploads = uploadsByDb.get(db);
  if (!uploads) {
    uploads = new Set();
    uploadsByDb.set(db, uploads);
  }
  return uploads;
}

/** The base64 `x-amz-checksum-sha256` header for a hex digest, as S3 expects it. */
export function checksumHeader(hex: string): string {
  const bytes = hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
  return btoa(String.fromCharCode(...bytes));
}

function listed(asset: AssetDetail) {
  const { alignment: _alignment, ...rest } = asset;
  return rest;
}

/**
 * Uploads: `assets.createUpload`, the presigned PUT and `assets.finalize`. Assets live in
 * `db.assets` beside the item page's voice takes, renders and posters, so `assets.get` and
 * `assets.url` (in `content-item.ts`) serve both. A ready asset with the same owner (the item, or
 * the workspace when there is no item), kind and SHA-256 answers `upload: null`, like the API.
 */
export function createUploadHandlers(db: MockDb) {
  const uploads = mockUploads(db);

  return [
    http.post(path("assets.createUpload"), async ({ request }) => {
      if (!db.signedIn) return unauthorized();
      const parsed = CreateUploadRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      const input = parsed.data;
      if (!db.workspaces.some((workspace) => workspace.id === input.workspaceId)) {
        return apiError(404, "not_found", "No workspace has that id.");
      }
      const existing = db.assets.find(
        (asset) =>
          asset.workspaceId === input.workspaceId &&
          asset.itemId === (input.itemId ?? null) &&
          asset.kind === input.kind &&
          asset.sha256 === input.sha256 &&
          asset.status === "ready",
      );
      if (existing) {
        return HttpResponse.json({ asset: listed(existing), upload: null }, { status: 201 });
      }
      const asset: AssetDetail = {
        id: mockId(),
        workspaceId: input.workspaceId,
        itemId: input.itemId ?? null,
        kind: input.kind,
        status: "pending",
        filename: input.filename,
        mime: input.mime,
        bytes: input.bytes,
        sha256: input.sha256,
        width: null,
        height: null,
        durationMs: null,
        probe: null,
        createdAt: new Date().toISOString(),
        finalizedAt: null,
        alignment: null,
      };
      db.assets.push(asset);
      publish(db, { type: "asset.updated", payload: { asset: listed(asset) } });
      const origin = new URL(request.url).origin;
      return HttpResponse.json(
        {
          asset: listed(asset),
          upload: {
            url: `${origin}${MOCK_STORAGE_PATH}/${asset.id}`,
            method: "PUT",
            headers: {
              "Content-Type": input.mime,
              "Content-Length": String(input.bytes),
              "x-amz-checksum-sha256": checksumHeader(input.sha256),
            },
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          },
        },
        { status: 201 },
      );
    }),

    http.put(`*${MOCK_STORAGE_PATH}/:id`, ({ params }) => {
      const id = String(params.id);
      if (!db.assets.some((asset) => asset.id === id)) {
        return new HttpResponse(null, { status: 404 });
      }
      uploads.add(id);
      return new HttpResponse(null, { status: 200 });
    }),

    http.post(path("assets.finalize"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const asset = db.assets.find((entry) => entry.id === params.id);
      if (!asset) return apiError(404, "not_found", "No asset has that id.");
      if (asset.status === "ready") return HttpResponse.json(listed(asset));
      if (!uploads.has(asset.id)) {
        return apiError(409, "upload_missing", "Nothing was uploaded for this asset yet.");
      }
      asset.status = "ready";
      asset.finalizedAt = new Date().toISOString();
      publish(db, { type: "asset.updated", payload: { asset: listed(asset) } });
      return HttpResponse.json(listed(asset));
    }),
  ];
}
