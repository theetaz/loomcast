import { describe, expect, it } from "vitest";
import {
  completeSteps,
  type LiveEvent,
  LiveEventSchema,
  type LiveEventType,
  parseLiveEvent,
} from "../src";
import {
  asset,
  at,
  channel,
  contentItem,
  deadTask,
  fakeSecret,
  ids,
  job,
  kbEntry,
  message,
  post,
  review,
  skillVersion,
  versionSummary,
  workspace,
} from "./fixtures";

const samples: { [T in LiveEventType]: Extract<LiveEvent, { type: T }> } = {
  "conversation.message.created": { type: "conversation.message.created", payload: { message } },
  "conversation.message.delta": {
    type: "conversation.message.delta",
    payload: { conversationId: ids.conversation, jobId: ids.job, text: "Hook one: " },
  },
  "job.updated": { type: "job.updated", payload: { job } },
  "job.activity": {
    type: "job.activity",
    payload: { jobId: ids.job, kind: "Read", summary: "Reading PROJECT.md" },
  },
  "device.status": {
    type: "device.status",
    payload: { deviceId: ids.device, online: true, lastSeenAt: at },
  },
  "workspace.created": { type: "workspace.created", payload: { workspace } },
  "workspace.updated": {
    type: "workspace.updated",
    payload: { workspace: { ...workspace, status: "archived", archivedAt: at } },
  },
  "kb.entry.created": { type: "kb.entry.created", payload: { entry: kbEntry } },
  "kb.entry.updated": {
    type: "kb.entry.updated",
    payload: { entry: { ...kbEntry, title: "Lead with the result" } },
  },
  "kb.entry.deleted": {
    type: "kb.entry.deleted",
    payload: { entryId: ids.entry, workspaceId: ids.workspace },
  },
  "content.item.created": {
    type: "content.item.created",
    payload: { item: { ...contentItem, state: "idea" } },
  },
  "content.item.updated": { type: "content.item.updated", payload: { item: contentItem } },
  "content.version.created": {
    type: "content.version.created",
    payload: { workspaceId: ids.workspace, version: versionSummary },
  },
  "content.progress.updated": {
    type: "content.progress.updated",
    payload: {
      progress: {
        itemId: ids.item,
        workspaceId: ids.workspace,
        title: "How a QR code works",
        itemState: "idea",
        source: "content-machine",
        path: "brands/unfolded/content/2026-12-05-qr-code",
        style: "build-ladder",
        steps: completeSteps([
          {
            key: "idea",
            status: "done",
            skill: null,
            tool: null,
            startedAt: null,
            finishedAt: at,
            note: null,
            error: null,
          },
        ]),
        checks: [],
        previewAssetId: null,
        revision: 1,
        inferred: false,
        stage: "research",
        health: "idle",
        reportedAt: at,
        updatedAt: at,
      },
    },
  },
  "asset.updated": { type: "asset.updated", payload: { asset } },
  "review.created": { type: "review.created", payload: { workspaceId: ids.workspace, review } },
  "skill.published": { type: "skill.published", payload: { skill: skillVersion } },
  "post.updated": {
    type: "post.updated",
    payload: {
      post: {
        ...post,
        status: "published",
        permalink: `dryrun://instagram/${ids.post}`,
        publishedAt: at,
      },
    },
  },
  "post.metrics.updated": {
    type: "post.metrics.updated",
    payload: {
      postId: ids.post,
      itemId: ids.item,
      workspaceId: ids.workspace,
      channelId: ids.channel,
      platform: "instagram",
      metrics: {
        capturedAt: at,
        views: 1200,
        likes: 80,
        comments: 6,
        shares: 4,
        saves: 10,
        reach: 950,
        avgWatchMs: 14_500,
      },
    },
  },
  "channel.updated": { type: "channel.updated", payload: { channel } },
  "task.dead": { type: "task.dead", payload: { task: deadTask } },
  resync: { type: "resync", payload: {} },
};

describe("live events", () => {
  it("has a sample for every event type", () => {
    const types = LiveEventSchema.options.map((option) => option.shape.type.value).sort();

    expect(Object.keys(samples).sort()).toEqual(types);
  });

  it.each(Object.values(samples))("round-trips $type", (event) => {
    expect(parseLiveEvent(JSON.stringify(event))).toEqual(event);
  });

  it("ignores unknown event types and invalid data", () => {
    expect(
      parseLiveEvent(JSON.stringify({ type: "calendar.slot.created", payload: {} })),
    ).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ type: "kb.entry.created", payload: {} }))).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ type: "job.updated", payload: {} }))).toBeNull();
    expect(
      parseLiveEvent(JSON.stringify({ type: "content.item.created", payload: {} })),
    ).toBeNull();
    expect(parseLiveEvent("not json")).toBeNull();
  });

  it("never carries channel credentials", () => {
    const leaked = {
      type: "channel.updated",
      payload: {
        channel: { ...channel, accessToken: fakeSecret("token"), secretNonce: fakeSecret("nonce") },
      },
    };
    const parsed = parseLiveEvent(JSON.stringify(leaked));

    expect(parsed).toEqual({ type: "channel.updated", payload: { channel } });
  });
});
