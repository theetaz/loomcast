import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CHANNEL_STATUSES,
  isScheduledTaskKind,
  OPEN_POST_STATUSES,
  PLATFORMS,
  POST_STATUSES,
  PUBLISHING_MODES,
  parseScheduledTaskPayload,
  RESCHEDULABLE_POST_STATUSES,
  SCHEDULED_TASK_KINDS,
  type ScheduledTaskPayload,
  scheduledTaskRegistry,
  TASK_BACKOFF_MAX_MS,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  TOKEN_REFRESH_LEAD_MS,
  taskRetryDelayMs,
} from "../src";
import { at, ids } from "./fixtures";

describe("channel, post and task enums", () => {
  it("keeps the values the database mirrors, in order", () => {
    expect(PLATFORMS).toEqual(["facebook", "instagram", "threads", "x"]);
    expect(CHANNEL_STATUSES).toEqual(["disconnected", "active", "needs_reauth", "disabled"]);
    expect(POST_STATUSES).toEqual([
      "planned",
      "queued",
      "publishing",
      "published",
      "failed",
      "cancelled",
      "missed",
    ]);
    expect(TASK_STATUSES).toEqual(["pending", "running", "succeeded", "failed", "dead"]);
    expect(PUBLISHING_MODES).toEqual(["dry-run", "live"]);
  });

  it("never reschedules a post that is publishing, published or cancelled", () => {
    for (const status of ["publishing", "published", "cancelled"] as const) {
      expect(RESCHEDULABLE_POST_STATUSES as readonly string[]).not.toContain(status);
    }
    for (const status of OPEN_POST_STATUSES) {
      expect(RESCHEDULABLE_POST_STATUSES).toContain(status);
    }
  });

  it("treats pending and running tasks as live", () => {
    expect(TERMINAL_TASK_STATUSES as readonly string[]).not.toContain("pending");
    expect(TERMINAL_TASK_STATUSES as readonly string[]).not.toContain("running");
  });
});

describe("scheduled task registry", () => {
  it("defines every task kind", () => {
    expect(Object.keys(scheduledTaskRegistry).sort()).toEqual([...SCHEDULED_TASK_KINDS].sort());
  });

  it.each(SCHEDULED_TASK_KINDS)("%s has a sane retry policy and lease", (kind) => {
    const definition = scheduledTaskRegistry[kind];

    expect(Number.isInteger(definition.maxAttempts)).toBe(true);
    expect(definition.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(definition.backoffBaseMs).toBeGreaterThanOrEqual(1_000);
    expect(definition.leaseMs).toBeGreaterThanOrEqual(10_000);
  });

  it("recognises task kinds", () => {
    expect(isScheduledTaskKind("post.publish")).toBe(true);
    expect(isScheduledTaskKind("channel.refresh_token")).toBe(true);
    expect(isScheduledTaskKind("channel.verify")).toBe(true);
    expect(isScheduledTaskKind("insights.pull")).toBe(true);
    expect(isScheduledTaskKind("post.delete")).toBe(false);
    expect(isScheduledTaskKind("system.ping")).toBe(false);
  });

  it("validates payloads by kind", () => {
    expect(parseScheduledTaskPayload("cadence.plan", {}).success).toBe(true);
    expect(parseScheduledTaskPayload("cadence.plan", { seriesId: ids.series }).success).toBe(true);
    expect(parseScheduledTaskPayload("cadence.produce", { itemId: ids.item }).success).toBe(true);
    expect(parseScheduledTaskPayload("cadence.produce", {}).success).toBe(false);
    expect(parseScheduledTaskPayload("post.publish", { postId: "post-1" }).success).toBe(false);
    expect(
      parseScheduledTaskPayload("post.check_status", { postId: ids.post, since: at }).success,
    ).toBe(true);
    expect(parseScheduledTaskPayload("post.check_status", { postId: ids.post }).success).toBe(
      false,
    );
    expect(parseScheduledTaskPayload("assets.cleanup", {}).success).toBe(true);
    for (const kind of ["channel.refresh_token", "channel.verify"] as const) {
      expect(parseScheduledTaskPayload(kind, {}).success, kind).toBe(true);
      expect(parseScheduledTaskPayload(kind, { channelId: ids.channel }).success, kind).toBe(true);
      expect(parseScheduledTaskPayload(kind, { channelId: "channel-1" }).success, kind).toBe(false);
    }
    expect(parseScheduledTaskPayload("insights.pull", { postId: ids.post }).success).toBe(true);
    expect(parseScheduledTaskPayload("insights.pull", {}).success).toBe(false);

    const parsed = parseScheduledTaskPayload("post.publish", { postId: ids.post });
    if (!parsed.success) throw parsed.error;
    expectTypeOf(parsed.data).toEqualTypeOf<ScheduledTaskPayload<"post.publish">>();
    expect(parsed.data.postId).toBe(ids.post);
  });
});

describe("token refresh lead times", () => {
  it("refreshes threads 15 days and x 10 minutes ahead, and never meta", () => {
    expect(TOKEN_REFRESH_LEAD_MS).toEqual({
      meta: null,
      threads: 15 * 24 * 60 * 60_000,
      x: 10 * 60_000,
    });
  });
});

describe("task retry delay", () => {
  const middle = () => 0.5;

  it("doubles from the base on every attempt", () => {
    expect(taskRetryDelayMs(60_000, 1, middle)).toBe(60_000);
    expect(taskRetryDelayMs(60_000, 2, middle)).toBe(120_000);
    expect(taskRetryDelayMs(60_000, 3, middle)).toBe(240_000);
  });

  it("caps the delay at one hour before the jitter", () => {
    expect(taskRetryDelayMs(60_000, 12, middle)).toBe(TASK_BACKOFF_MAX_MS);
    expect(taskRetryDelayMs(60_000, 10_000, middle)).toBe(TASK_BACKOFF_MAX_MS);
  });

  it("varies the delay by at most 20% either way", () => {
    expect(taskRetryDelayMs(60_000, 1, () => 0)).toBe(48_000);
    expect(taskRetryDelayMs(60_000, 1, () => 0.999_999)).toBeLessThanOrEqual(72_000);
    expect(taskRetryDelayMs(60_000, 1, () => 0.999_999)).toBeGreaterThan(71_999);
    for (let index = 0; index < 100; index += 1) {
      const delay = taskRetryDelayMs(15_000, 3);
      expect(delay).toBeGreaterThanOrEqual(48_000);
      expect(delay).toBeLessThanOrEqual(72_000);
    }
  });

  it("treats a first or invalid attempt number as the first run", () => {
    expect(taskRetryDelayMs(30_000, 0, middle)).toBe(30_000);
    expect(taskRetryDelayMs(30_000, -3, middle)).toBe(30_000);
  });
});
