import { randomUUID } from "node:crypto";
import {
  API_V1_RATE_LIMIT,
  ApiPostMetricsSchema,
  ApiPostSchema,
  ApiPostWithUploadsSchema,
  ApiV1MeSchema,
  cursorPageSchema,
  DRY_RUN_PERMALINK_SCHEME,
  PostFormatsOutputSchema,
} from "@loomcast/contracts";
import { auditLog, contentItems, reviews, scheduledPosts } from "@loomcast/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetStorageKey } from "../src/lib/storage";
import { mimeMatches, sniffMediaMime } from "../src/modules/api-v1";
import { type ApiHarness, createApiHarness, machine, mediaFile } from "./api-support";
import { insertChannel, runDue, testKeyring } from "./publisher-support";
import {
  putUpload,
  removeObjects,
  resolveStorageTarget,
  type StorageTarget,
} from "./storage-support";
import { errorCode } from "./support";

// The machine API end to end: API keys, access levels, channel isolation, format refusals,
// idempotency, the upload and finalize flow for photos and carousels, text posts, rescheduling,
// cancelling, listing, rate limits and a dry-run publish read back through GET.

const target: StorageTarget = await resolveStorageTarget();
const keyring = testKeyring();
const HOUR_MS = 60 * 60_000;

let h: ApiHarness;
let facebookId: string;
let instagramId: string;
let gatedId: string;
let hiddenId: string;
const storedKeys: string[] = [];

beforeAll(async () => {
  h = await createApiHarness({ config: { storage: target.config } });
  facebookId = (await insertChannel(h.testDb.db, keyring, { platform: "facebook" })).id;
  instagramId = (await insertChannel(h.testDb.db, keyring, { platform: "instagram" })).id;
  gatedId = (
    await insertChannel(h.testDb.db, keyring, { platform: "facebook", requiresApproval: true })
  ).id;
  hiddenId = (await insertChannel(h.testDb.db, keyring, { platform: "facebook" })).id;
});

afterAll(async () => {
  await removeObjects(target, target.config.bucket, storedKeys);
  await h.close();
  await target.close();
});

function ahead(hours: number): string {
  return new Date(h.t.clock.now().getTime() + hours * HOUR_MS).toISOString();
}

function textPost(channelIds: string[], extra: Record<string, unknown> = {}) {
  return {
    format: "text",
    caption: "Read the release notes.",
    channels: channelIds.map((channelId) => ({ channelId })),
    scheduledAt: ahead(2),
    ...extra,
  };
}

async function created(response: Response) {
  expect(response.status, await response.clone().text()).toBe(201);
  return ApiPostWithUploadsSchema.parse(await response.json());
}

async function ok(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ApiPostSchema.parse(await response.json());
}

describe("authentication", () => {
  it("accepts only a live API key in the Authorization header", async () => {
    const { client, secret } = await h.createClient([{ channelId: facebookId, access: "read" }]);
    const me = await machine(h.t, secret, "GET", "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(me.headers.get("ratelimit-limit")).toBe(String(API_V1_RATE_LIMIT.capacity));
    expect(ApiV1MeSchema.parse(await me.json())).toMatchObject({
      client: { id: client.id, name: client.name, prefix: client.prefix },
      project: { id: h.projectId },
      grants: [{ channelId: facebookId, access: "read" }],
      rateLimit: { requests: 120, perSeconds: 60 },
    });

    const missing = await machine(h.t, null, "GET", "/api/v1/me");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    const invalid = await machine(h.t, `lc_api_${"0".repeat(43)}`, "GET", "/api/v1/me");
    expect(invalid.status).toBe(401);
    const wrongPrefix = await machine(
      h.t,
      secret.replace("lc_api_", "lc_mcp_"),
      "GET",
      "/api/v1/me",
    );
    expect(wrongPrefix.status).toBe(401);
    // A browser session is not a key: the cookie is never read here.
    const cookieOnly = await machine(h.t, null, "GET", "/api/v1/me", { cookie: h.cookie });
    expect(cookieOnly.status).toBe(401);
    const unknownPath = await machine(h.t, null, "GET", "/api/v1/nope");
    expect(unknownPath.status).toBe(401);
    expect((await machine(h.t, secret, "GET", "/api/v1/nope")).status).toBe(404);
  });

  it("refuses an expired key", async () => {
    const { secret } = await h.createClient([{ channelId: facebookId, access: "read" }], {
      expiresAt: ahead(1),
    });
    expect((await machine(h.t, secret, "GET", "/api/v1/me")).status).toBe(200);
    h.t.clock.advance(2 * HOUR_MS);
    expect((await machine(h.t, secret, "GET", "/api/v1/me")).status).toBe(401);
  });

  it("limits each client to its rate", async () => {
    const { secret } = await h.createClient([{ channelId: facebookId, access: "read" }]);
    const other = await h.createClient([{ channelId: facebookId, access: "read" }]);
    for (let request = 0; request < API_V1_RATE_LIMIT.capacity; request += 1) {
      expect((await machine(h.t, secret, "GET", "/api/v1/formats")).status).toBe(200);
    }
    const limited = await machine(h.t, secret, "GET", "/api/v1/formats");
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another client has a bucket of its own.
    expect((await machine(h.t, other.secret, "GET", "/api/v1/formats")).status).toBe(200);
  });
});

describe("channels and formats", () => {
  it("lists only granted channels with their access and formats", async () => {
    const { secret } = await h.createClient([
      { channelId: instagramId, access: "write" },
      { channelId: facebookId, access: "publish" },
    ]);
    const response = await machine(h.t, secret, "GET", "/api/v1/channels");
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as {
      items: { id: string; platform: string; access: string; formats: string[]; dryRun: boolean }[];
    };
    expect(items.map((channel) => channel.id).sort()).toEqual([facebookId, instagramId].sort());
    expect(items.find((channel) => channel.id === instagramId)).toMatchObject({
      platform: "instagram",
      access: "write",
      formats: ["reel", "image", "carousel", "story"],
      dryRun: true,
    });
    const formats = await machine(h.t, secret, "GET", "/api/v1/formats");
    expect(PostFormatsOutputSchema.parse(await formats.json()).formats).toHaveLength(6);
  });
});

describe("access levels", () => {
  it("does not let a read client create posts", async () => {
    const { secret } = await h.createClient([{ channelId: facebookId, access: "read" }]);
    const response = await machine(h.t, secret, "POST", "/api/v1/posts", {
      body: textPost([facebookId]),
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("names ungranted and unknown channels alike, without leaking either", async () => {
    const { secret } = await h.createClient([{ channelId: facebookId, access: "publish" }]);
    const response = await machine(h.t, secret, "POST", "/api/v1/posts", {
      body: textPost([facebookId, hiddenId, randomUUID()]),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { details: { path: string; message: string }[] };
    };
    expect(body.error.details.map((issue) => issue.path)).toEqual([
      "channels.1.channelId",
      "channels.2.channelId",
    ]);
    expect(new Set(body.error.details.map((issue) => issue.message)).size).toBe(1);
  });

  it("lets a write client schedule a post that waits for the owner's approval", async () => {
    const { secret } = await h.createClient([{ channelId: facebookId, access: "write" }]);
    const post = await created(
      await machine(h.t, secret, "POST", "/api/v1/posts", { body: textPost([facebookId]) }),
    );
    await h.settle();
    expect(post).toMatchObject({ status: "pending_approval", own: true, format: "text" });
    expect(post.uploads).toEqual([]);
    expect(post.targets).toMatchObject([
      { channelId: facebookId, platform: "facebook", status: "planned", dryRun: true },
    ]);
    const [item] = await h.testDb.db
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, post.id));
    expect(item).toMatchObject({ state: "review", createdVia: "api", projectId: h.projectId });

    const inbox = (await (await h.owner("GET", "/api/approvals")).json()) as {
      items: { item: { id: string } }[];
    };
    expect(inbox.items.map((entry) => entry.item.id)).toContain(post.id);

    // The owner approves it in the web app; the post is then queued.
    const approved = await h.owner("POST", `/api/content/${post.id}/reviews`, {
      versionId: item?.currentVersionId,
      decision: "approve",
    });
    expect(approved.status, await approved.clone().text()).toBe(201);
    await h.settle();
    const after = await ok(await machine(h.t, secret, "GET", `/api/v1/posts/${post.id}`));
    expect(after.status).toBe("scheduled");
    expect(after.targets[0]?.status).toBe("queued");
  });

  it("lets a publish client schedule straight away, approved on the owner's behalf", async () => {
    const { client, secret } = await h.createClient([{ channelId: facebookId, access: "publish" }]);
    const post = await created(
      await machine(h.t, secret, "POST", "/api/v1/posts", {
        body: textPost([facebookId], { externalRef: "release-42" }),
      }),
    );
    expect(post).toMatchObject({ status: "scheduled", externalRef: "release-42" });
    expect(post.targets[0]).toMatchObject({ status: "queued", scheduledAt: expect.any(String) });
    const [review] = await h.testDb.db.select().from(reviews).where(eq(reviews.itemId, post.id));
    expect(review).toMatchObject({ decision: "approve", userId: h.ownerId, actorKind: "user" });
    expect(review?.comment).toContain(client.name);

    const audited = await h.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "api.request"), eq(auditLog.targetId, post.id)));
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actorKind: "token", actorId: client.id });
  });

  it("keeps a channel's own approval rule even for a publish client", async () => {
    const { secret } = await h.createClient([{ channelId: gatedId, access: "publish" }]);
    const post = await created(
      await machine(h.t, secret, "POST", "/api/v1/posts", { body: textPost([gatedId]) }),
    );
    await h.settle();
    expect(post.status).toBe("pending_approval");
  });

  it("refuses a format a channel's platform does not publish", async () => {
    const { secret } = await h.createClient([
      { channelId: facebookId, access: "publish" },
      { channelId: instagramId, access: "publish" },
    ]);
    const response = await machine(h.t, secret, "POST", "/api/v1/posts", {
      body: textPost([facebookId, instagramId]),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("format_not_supported");
    expect(body.error.message).toContain("channels.1.channelId");
    expect(body.error.message).toContain("Instagram does not publish text posts");
  });

  it("validates media against the format and the time against the lead", async () => {
    const { secret } = await h.createClient([{ channelId: instagramId, access: "publish" }]);
    const noPhoto = await machine(h.t, secret, "POST", "/api/v1/posts", {
      body: {
        format: "image",
        channels: [{ channelId: instagramId }],
        scheduledAt: ahead(2),
      },
    });
    expect(noPhoto.status).toBe(400);
    const tooSoon = await machine(h.t, secret, "POST", "/api/v1/posts", {
      body: {
        format: "image",
        media: [{ filename: "a.jpg", mime: "image/jpeg", bytes: 10, sha256: "a".repeat(64) }],
        channels: [{ channelId: instagramId }],
        scheduledAt: new Date(h.t.clock.now().getTime() + 30_000).toISOString(),
      },
    });
    expect(tooSoon.status).toBe(400);
  });
});

describe("idempotency", () => {
  it("replays a request with the same key and refuses another body", async () => {
    const { secret } = await h.createClient([{ channelId: facebookId, access: "publish" }]);
    const body = textPost([facebookId]);
    const headers = { "Idempotency-Key": `order-${randomUUID()}` };
    const first = await created(
      await machine(h.t, secret, "POST", "/api/v1/posts", { body, headers }),
    );
    const again = await machine(h.t, secret, "POST", "/api/v1/posts", { body, headers });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect((await created(again)).id).toBe(first.id);

    const changed = await machine(h.t, secret, "POST", "/api/v1/posts", {
      body: { ...body, caption: "Another caption." },
      headers,
    });
    expect(changed.status).toBe(409);
    expect(await errorCode(changed)).toBe("idempotency_conflict");

    const fresh = await created(await machine(h.t, secret, "POST", "/api/v1/posts", { body }));
    expect(fresh.id).not.toBe(first.id);
    const bad = await machine(h.t, secret, "POST", "/api/v1/posts", {
      body,
      headers: { "Idempotency-Key": "has space" },
    });
    expect(bad.status).toBe(400);
  });
});

describe("uploads and finalize", () => {
  async function upload(
    post: { uploads: { url: string; method: string; headers: Record<string, string> }[] },
    files: Buffer[],
  ) {
    for (const [index, entry] of post.uploads.entries()) {
      const file = files[index];
      if (file === undefined) throw new Error("no file for the upload");
      expect((await putUpload(entry, file)).status).toBe(200);
    }
  }

  function remember(itemId: string, mime: string, sha256: string) {
    storedKeys.push(assetStorageKey({ projectId: h.projectId, itemId }, "media", sha256, mime));
  }

  it("uploads a photo, finalizes it and schedules it on Instagram and Facebook", async () => {
    const { secret } = await h.createClient([
      { channelId: instagramId, access: "publish" },
      { channelId: facebookId, access: "publish" },
    ]);
    const photo = mediaFile("image/jpeg");
    const post = await created(
      await machine(h.t, secret, "POST", "/api/v1/posts", {
        body: {
          format: "image",
          caption: "Launch day.",
          media: [
            {
              filename: "launch.jpg",
              mime: "image/jpeg",
              bytes: photo.bytes.length,
              sha256: photo.sha256,
              altText: "The launch stage",
            },
          ],
          channels: [
            { channelId: instagramId, options: { instagram: { collaborators: ["loomcast"] } } },
            { channelId: facebookId },
          ],
          scheduledAt: ahead(3),
        },
      }),
    );
    remember(post.id, "image/jpeg", photo.sha256);
    expect(post.status).toBe("awaiting_media");
    expect(post.media).toMatchObject([
      { type: "image", status: "pending", altText: "The launch stage" },
    ]);
    expect(post.targets.map((entry) => entry.postId)).toEqual([null, null]);
    expect(post.uploads).toHaveLength(1);
    expect(post.uploads[0]).toMatchObject({
      mediaId: post.media[0]?.mediaId,
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", "Content-Length": String(photo.bytes.length) },
    });

    const early = await machine(h.t, secret, "POST", `/api/v1/posts/${post.id}/finalize`);
    expect(early.status).toBe(409);
    expect(await errorCode(early)).toBe("upload_missing");

    await upload(post, [photo.bytes]);
    const done = await ok(await machine(h.t, secret, "POST", `/api/v1/posts/${post.id}/finalize`));
    expect(done.status).toBe("scheduled");
    expect(done.media).toMatchObject([
      { type: "image", status: "ready", altText: "The launch stage" },
    ]);
    expect(done.targets.map((entry) => entry.status)).toEqual(["queued", "queued"]);
    const [onInstagram] = await h.testDb.db
      .select()
      .from(scheduledPosts)
      .where(and(eq(scheduledPosts.itemId, post.id), eq(scheduledPosts.channelId, instagramId)));
    expect(onInstagram?.options).toEqual({ instagram: { collaborators: ["loomcast"] } });

    // Finalizing again is a no-op.
    const twice = await ok(await machine(h.t, secret, "POST", `/api/v1/posts/${post.id}/finalize`));
    expect(twice.targets.map((entry) => entry.postId)).toEqual(
      done.targets.map((entry) => entry.postId),
    );
  });

  it("keeps a carousel's order and alt texts", async () => {
    const { secret } = await h.createClient([{ channelId: instagramId, access: "publish" }]);
    const first = mediaFile("image/png");
    const second = mediaFile("image/jpeg");
    const third = mediaFile("video/mp4");
    const files = [first, second, third];
    const mimes = ["image/png", "image/jpeg", "video/mp4"] as const;
    const post = await created(
      await machine(h.t, secret, "POST", "/api/v1/posts", {
        body: {
          format: "carousel",
          caption: "Three steps.",
          media: files.map((file, index) => ({
            filename: `step-${index}`,
            mime: mimes[index],
            bytes: file.bytes.length,
            sha256: file.sha256,
            ...(index === 0 ? { altText: "Step one" } : {}),
            ...(index === 2 ? { width: 1080, height: 1350, durationMs: 12_000 } : {}),
          })),
          channels: [{ channelId: instagramId }],
          scheduledAt: ahead(3),
        },
      }),
    );
    for (const [index, file] of files.entries()) {
      remember(post.id, mimes[index] ?? "image/png", file.sha256);
    }
    expect(post.uploads).toHaveLength(3);
    await upload(
      post,
      files.map((file) => file.bytes),
    );
    const done = await ok(await machine(h.t, secret, "POST", `/api/v1/posts/${post.id}/finalize`));
    expect(done.status).toBe("scheduled");
    expect(done.media.map((entry) => [entry.mediaId, entry.type, entry.altText])).toEqual(
      post.media.map((entry, index) => [
        entry.mediaId,
        index === 2 ? "video" : "image",
        index === 0 ? "Step one" : null,
      ]),
    );
  });

  it("refuses bytes that are not of the declared type", async () => {
    const { secret } = await h.createClient([{ channelId: instagramId, access: "publish" }]);
    const jpeg = mediaFile("image/jpeg");
    const post = await created(
      await machine(h.t, secret, "POST", "/api/v1/posts", {
        body: {
          format: "story",
          media: [
            {
              filename: "story.png",
              mime: "image/png",
              bytes: jpeg.bytes.length,
              sha256: jpeg.sha256,
            },
          ],
          channels: [{ channelId: instagramId }],
          scheduledAt: ahead(3),
        },
      }),
    );
    remember(post.id, "image/png", jpeg.sha256);
    await upload(post, [jpeg.bytes]);
    const response = await machine(h.t, secret, "POST", `/api/v1/posts/${post.id}/finalize`);
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("media_type_mismatch");
    // Cancelling withdraws it.
    const cancelled = await ok(
      await machine(h.t, secret, "POST", `/api/v1/posts/${post.id}/cancel`),
    );
    expect(cancelled.status).toBe("cancelled");
  });

  it("gives fresh upload URLs for files not uploaded yet", async () => {
    const { secret } = await h.createClient([{ channelId: instagramId, access: "write" }]);
    const photo = mediaFile("image/jpeg");
    const post = await created(
      await machine(h.t, secret, "POST", "/api/v1/posts", {
        body: {
          format: "image",
          media: [
            {
              filename: "a.jpg",
              mime: "image/jpeg",
              bytes: photo.bytes.length,
              sha256: photo.sha256,
            },
          ],
          channels: [{ channelId: instagramId }],
          scheduledAt: ahead(3),
        },
      }),
    );
    remember(post.id, "image/jpeg", photo.sha256);
    const refreshed = await machine(h.t, secret, "POST", `/api/v1/posts/${post.id}/uploads`);
    expect(refreshed.status).toBe(200);
    const body = ApiPostWithUploadsSchema.parse(await refreshed.json());
    expect(body.uploads.map((entry) => entry.mediaId)).toEqual(
      post.uploads.map((entry) => entry.mediaId),
    );
    await upload(body, [photo.bytes]);
    const done = await ok(await machine(h.t, secret, "POST", `/api/v1/posts/${post.id}/finalize`));
    await h.settle();
    // A write client's post waits for approval after finalize.
    expect(done.status).toBe("pending_approval");
  });
});

describe("rescheduling, cancelling and listing", () => {
  it("moves and cancels every open post of a post", async () => {
    const { secret } = await h.createClient([{ channelId: facebookId, access: "publish" }]);
    const post = await created(
      await machine(h.t, secret, "POST", "/api/v1/posts", { body: textPost([facebookId]) }),
    );
    const later = ahead(6);
    const moved = await ok(
      await machine(h.t, secret, "PATCH", `/api/v1/posts/${post.id}`, {
        body: { scheduledAt: later },
      }),
    );
    expect(moved.scheduledAt).toBe(later);
    expect(moved.targets[0]?.scheduledAt).toBe(later);

    const cancelled = await ok(
      await machine(h.t, secret, "POST", `/api/v1/posts/${post.id}/cancel`),
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.targets[0]?.status).toBe("cancelled");
    const [item] = await h.testDb.db
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, post.id));
    expect(item?.state).toBe("archived");
    // Cancelling again is a no-op; moving a cancelled post is refused.
    expect((await machine(h.t, secret, "POST", `/api/v1/posts/${post.id}/cancel`)).status).toBe(
      200,
    );
    const refused = await machine(h.t, secret, "PATCH", `/api/v1/posts/${post.id}`, {
      body: { scheduledAt: ahead(8) },
    });
    expect(refused.status).toBe(409);
  });

  it("pages through the posts a client can see, and only those", async () => {
    const author = await h.createClient([{ channelId: hiddenId, access: "publish" }]);
    const reader = await h.createClient([{ channelId: hiddenId, access: "read" }]);
    const stranger = await h.createClient([{ channelId: facebookId, access: "publish" }]);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const post = await created(
        await machine(h.t, author.secret, "POST", "/api/v1/posts", {
          body: textPost([hiddenId], { externalRef: `ref-${index}` }),
        }),
      );
      ids.push(post.id);
    }
    const Page = cursorPageSchema(ApiPostSchema);
    const first = Page.parse(
      await (await machine(h.t, author.secret, "GET", "/api/v1/posts?limit=2")).json(),
    );
    expect(first.items.map((post) => post.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    const second = Page.parse(
      await (
        await machine(h.t, author.secret, "GET", `/api/v1/posts?limit=2&cursor=${first.nextCursor}`)
      ).json(),
    );
    expect(second.items.map((post) => post.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();

    // Read access on the channel shows the posts, without the author's reference or changes.
    const seen = Page.parse(
      await (
        await machine(
          h.t,
          reader.secret,
          "GET",
          `/api/v1/posts?channelId=${hiddenId}&status=scheduled`,
        )
      ).json(),
    );
    expect(seen.items.map((post) => post.id)).toEqual([...ids].reverse());
    expect(seen.items.every((post) => !post.own && post.externalRef === null)).toBe(true);
    const change = await machine(h.t, reader.secret, "POST", `/api/v1/posts/${ids[0]}/cancel`);
    expect(change.status).toBe(403);

    // A client without the channel sees nothing of them, as if they did not exist.
    const none = Page.parse(
      await (await machine(h.t, stranger.secret, "GET", "/api/v1/posts")).json(),
    );
    expect(none.items.filter((post) => ids.includes(post.id))).toEqual([]);
    const hidden = await machine(h.t, stranger.secret, "GET", `/api/v1/posts/${ids[0]}`);
    expect(hidden.status).toBe(404);
    const filter = await machine(
      h.t,
      stranger.secret,
      "GET",
      `/api/v1/posts?channelId=${hiddenId}`,
    );
    expect(filter.status).toBe(400);
  });
});

describe("publishing", () => {
  it("publishes in dry run and shows the permalink and metrics through GET", async () => {
    const { secret } = await h.createClient([{ channelId: facebookId, access: "publish" }]);
    const post = await created(
      await machine(h.t, secret, "POST", "/api/v1/posts", {
        body: textPost([facebookId], { scheduledAt: ahead(1) }),
      }),
    );
    h.t.clock.advance(2 * HOUR_MS);
    await runDue(h.deps.scheduler);
    const published = await ok(await machine(h.t, secret, "GET", `/api/v1/posts/${post.id}`));
    expect(published.status).toBe("published");
    expect(published.targets[0]).toMatchObject({ status: "published", dryRun: true });
    expect(published.targets[0]?.permalink?.startsWith(DRY_RUN_PERMALINK_SCHEME)).toBe(true);

    const metrics = await machine(h.t, secret, "GET", `/api/v1/posts/${post.id}/metrics`);
    expect(metrics.status).toBe(200);
    expect(ApiPostMetricsSchema.parse(await metrics.json()).targets).toMatchObject([
      { channelId: facebookId, platform: "facebook", metrics: null },
    ]);
    const listed = cursorPageSchema(ApiPostSchema).parse(
      await (await machine(h.t, secret, "GET", "/api/v1/posts?status=published")).json(),
    );
    expect(listed.items.map((item) => item.id)).toContain(post.id);
  });

  it("publishes a Reel from an uploaded video with the size and duration the client gave", async () => {
    const { secret } = await h.createClient([{ channelId: facebookId, access: "publish" }]);
    const video = mediaFile("video/mp4");
    const file = {
      filename: "reel.mp4",
      mime: "video/mp4",
      bytes: video.bytes.length,
      sha256: video.sha256,
    };
    const undeclared = await machine(h.t, secret, "POST", "/api/v1/posts", {
      body: {
        format: "reel",
        media: [file],
        channels: [{ channelId: facebookId }],
        scheduledAt: ahead(1),
      },
    });
    expect(undeclared.status).toBe(400);
    const body = (await undeclared.json()) as { error: { details: { path: string }[] } };
    expect(body.error.details.map((issue) => issue.path).sort()).toEqual([
      "media.0.durationMs",
      "media.0.height",
      "media.0.width",
    ]);

    const post = await created(
      await machine(h.t, secret, "POST", "/api/v1/posts", {
        body: {
          format: "reel",
          caption: "Shipped.",
          media: [{ ...file, width: 1080, height: 1920, durationMs: 20_000 }],
          channels: [{ channelId: facebookId }],
          scheduledAt: ahead(1),
        },
      }),
    );
    storedKeys.push(
      assetStorageKey(
        { projectId: h.projectId, itemId: post.id },
        "media",
        video.sha256,
        "video/mp4",
      ),
    );
    const [upload] = post.uploads;
    if (upload === undefined) throw new Error("no upload");
    expect((await putUpload(upload, video.bytes)).status).toBe(200);
    expect(
      (await ok(await machine(h.t, secret, "POST", `/api/v1/posts/${post.id}/finalize`))).status,
    ).toBe("scheduled");
    h.t.clock.advance(2 * HOUR_MS);
    await runDue(h.deps.scheduler);
    const published = await ok(await machine(h.t, secret, "GET", `/api/v1/posts/${post.id}`));
    expect(published.targets[0]?.lastError ?? null).toBeNull();
    expect(published.status).toBe("published");
  });
});

describe("media sniffing", () => {
  it("reads the type from the leading bytes", () => {
    expect(sniffMediaMime(mediaFile("image/jpeg").bytes)).toBe("image/jpeg");
    expect(sniffMediaMime(mediaFile("image/png").bytes)).toBe("image/png");
    expect(sniffMediaMime(mediaFile("video/mp4").bytes)).toBe("video/mp4");
    const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");
    expect(sniffMediaMime(webp)).toBe("image/webp");
    const mov = Buffer.from("\0\0\0\x14ftypqt  \0\0\0\0", "latin1");
    expect(sniffMediaMime(mov)).toBe("video/quicktime");
    expect(sniffMediaMime(Buffer.from("plain text here!"))).toBeNull();
  });

  it("needs photos to match exactly and videos to be videos", () => {
    expect(mimeMatches("image/png", "image/jpeg")).toBe(false);
    expect(mimeMatches("image/jpeg", "image/jpeg")).toBe(true);
    expect(mimeMatches("video/quicktime", "video/mp4")).toBe(true);
    expect(mimeMatches("video/mp4", "image/png")).toBe(false);
    expect(mimeMatches("image/jpeg", null)).toBe(false);
  });
});
