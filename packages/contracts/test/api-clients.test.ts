import { describe, expect, it } from "vitest";
import {
  accessIncludes,
  CreateApiClientRequestSchema,
  CreateApiPostRequestSchema,
  IdempotencyKeySchema,
  routes,
  UpdateApiClientRequestSchema,
} from "../src";
import { ids } from "./fixtures";

const channelId = "0b9f4a8e-6c1d-4e2f-9a3b-5c7d8e9f0a1b";
const otherChannelId = "1c0a5b9f-7d2e-4f3a-8b4c-6d8e9f0a1b2c";
const sha256 = "a".repeat(64);

describe("API client access levels", () => {
  it("are cumulative", () => {
    expect(accessIncludes("publish", "write")).toBe(true);
    expect(accessIncludes("write", "read")).toBe(true);
    expect(accessIncludes("read", "write")).toBe(false);
    expect(accessIncludes("write", "publish")).toBe(false);
  });
});

describe("API client management", () => {
  const valid = {
    name: "Blog backend",
    projectId: ids.project,
    grants: [{ channelId, access: "write" }],
  };

  it("needs at least one grant and each channel once", () => {
    expect(CreateApiClientRequestSchema.safeParse(valid).success).toBe(true);
    expect(CreateApiClientRequestSchema.safeParse({ ...valid, grants: [] }).success).toBe(false);
    const twice = {
      ...valid,
      grants: [
        { channelId, access: "read" },
        { channelId, access: "publish" },
      ],
    };
    expect(CreateApiClientRequestSchema.safeParse(twice).success).toBe(false);
    const unknownLevel = { ...valid, grants: [{ channelId, access: "admin" }] };
    expect(CreateApiClientRequestSchema.safeParse(unknownLevel).success).toBe(false);
  });

  it("refuses unknown fields and empty updates", () => {
    expect(CreateApiClientRequestSchema.safeParse({ ...valid, scopes: [] }).success).toBe(false);
    expect(UpdateApiClientRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateApiClientRequestSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });
});

describe("machine API posts", () => {
  const photo = {
    format: "image",
    caption: "Launch day.",
    media: [{ filename: "launch.jpg", mime: "image/jpeg", bytes: 1024, sha256 }],
    channels: [{ channelId }, { channelId: otherChannelId }],
    scheduledAt: "2026-11-01T09:00:00.000Z",
  };

  it("accepts a photo for two channels", () => {
    expect(CreateApiPostRequestSchema.safeParse(photo).success).toBe(true);
  });

  it("refuses repeated channels and files, and files a post cannot carry", () => {
    const sameChannel = { ...photo, channels: [{ channelId }, { channelId }] };
    expect(CreateApiPostRequestSchema.safeParse(sameChannel).success).toBe(false);
    const sameFile = { ...photo, media: [photo.media[0], photo.media[0]] };
    expect(CreateApiPostRequestSchema.safeParse(sameFile).success).toBe(false);
    const audio = { ...photo, media: [{ ...photo.media[0], mime: "audio/mpeg" }] };
    expect(CreateApiPostRequestSchema.safeParse(audio).success).toBe(false);
    expect(CreateApiPostRequestSchema.safeParse({ ...photo, channels: [] }).success).toBe(false);
    expect(CreateApiPostRequestSchema.safeParse({ ...photo, extra: true }).success).toBe(false);
  });

  it("takes idempotency keys of visible ASCII only", () => {
    expect(IdempotencyKeySchema.safeParse("order-1234:v1").success).toBe(true);
    expect(IdempotencyKeySchema.safeParse("has space").success).toBe(false);
    expect(IdempotencyKeySchema.safeParse("x".repeat(201)).success).toBe(false);
  });

  it("registers every machine route under /api/v1 with API-key auth", () => {
    const machine = Object.entries(routes).filter(([name]) => name.startsWith("v1."));
    expect(machine.length).toBeGreaterThan(0);
    for (const [name, route] of machine) {
      expect(route.auth, name).toBe("api_key");
      expect(route.path.startsWith("/api/v1/"), name).toBe(true);
    }
    for (const [name, route] of Object.entries(routes)) {
      if (route.path.startsWith("/api/v1/")) {
        expect(name.startsWith("v1."), name).toBe(true);
      }
    }
  });
});
