import { describe, expect, it } from "vitest";
import { type LiveEvent, LiveEventSchema, type LiveEventType, parseLiveEvent } from "../src";
import { at, ids, job, kbEntry, message, project } from "./fixtures";

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
  "project.created": { type: "project.created", payload: { project } },
  "project.updated": {
    type: "project.updated",
    payload: { project: { ...project, status: "archived", archivedAt: at } },
  },
  "kb.entry.created": { type: "kb.entry.created", payload: { entry: kbEntry } },
  "kb.entry.updated": {
    type: "kb.entry.updated",
    payload: { entry: { ...kbEntry, title: "Lead with the result" } },
  },
  "kb.entry.deleted": {
    type: "kb.entry.deleted",
    payload: { entryId: ids.entry, projectId: ids.project },
  },
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
      parseLiveEvent(JSON.stringify({ type: "content.item.created", payload: {} })),
    ).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ type: "kb.entry.created", payload: {} }))).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ type: "job.updated", payload: {} }))).toBeNull();
    expect(parseLiveEvent("not json")).toBeNull();
  });
});
