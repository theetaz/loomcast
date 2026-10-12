import { describe, expect, expectTypeOf, it } from "vitest";
import {
  allowsEventKind,
  CONCURRENCY_CLASSES,
  isJobType,
  JOB_EVENT_KINDS,
  JOB_TYPES,
  type JobPayload,
  type JobResult,
  jobRegistry,
  parseJobPayload,
  parseJobResult,
  projectTools,
  TOKEN_SCOPES,
} from "../src";
import { ids, project } from "./fixtures";

const chatPayload = {
  conversationId: ids.conversation,
  projectId: ids.project,
  messageId: ids.message,
  text: "Draft three hooks about ownership.",
};

describe("job registry", () => {
  it("has an entry for every job type and nothing else", () => {
    expect(Object.keys(jobRegistry).sort()).toEqual([...JOB_TYPES].sort());
  });

  it.each(JOB_TYPES)("describes %s completely", (type) => {
    const definition = jobRegistry[type];

    expect(definition.timeoutMs).toBeGreaterThan(0);
    expect(definition.retry.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(["requeue", "fail"]).toContain(definition.retry.onLeaseExpiry);
    expect(CONCURRENCY_CLASSES).toContain(definition.concurrencyClass);
    expect(definition.durableEventKinds.length).toBeGreaterThan(0);
    for (const kind of definition.durableEventKinds) {
      expect(JOB_EVENT_KINDS).toContain(kind);
    }
  });

  it("fails interrupted chats instead of running them twice", () => {
    const chat = jobRegistry["producer.chat"];

    expect(chat.timeoutMs).toBe(30 * 60 * 1000);
    expect(chat.retry).toEqual({ maxAttempts: 1, onLeaseExpiry: "fail" });
    expect(allowsEventKind("producer.chat", "assistant.message")).toBe(true);
    expect(allowsEventKind("system.ping", "assistant.message")).toBe(false);
  });

  it("recognises only registered job types", () => {
    expect(isJobType("producer.chat")).toBe(true);
    expect(isJobType("shell.exec")).toBe(false);
    expect(isJobType("")).toBe(false);
  });

  it("validates payloads per job type", () => {
    expect(parseJobPayload("system.ping", {}).success).toBe(true);
    expect(parseJobPayload("producer.chat", chatPayload).success).toBe(true);
    expect(
      parseJobPayload("producer.chat", { ...chatPayload, producerSessionId: "session-1" }).success,
    ).toBe(true);
    expect(parseJobPayload("producer.chat", { ...chatPayload, text: "   " }).success).toBe(false);
    expect(
      parseJobPayload("producer.chat", { ...chatPayload, text: "x".repeat(20_001) }).success,
    ).toBe(false);
    expect(parseJobPayload("producer.chat", { text: "hi" }).success).toBe(false);
  });

  it("validates results per job type", () => {
    const ping = {
      agentVersion: "0.1.0",
      runtime: { node: "v24.19.0", platform: "darwin" },
      producerAvailable: true,
    };
    const chat = { sdkSessionId: "session-1", finalText: "Done.", numTurns: 3, durationMs: 1532.5 };

    expect(parseJobResult("system.ping", ping).success).toBe(true);
    expect(parseJobResult("producer.chat", chat).success).toBe(true);
    expect(parseJobResult("producer.chat", ping).success).toBe(false);
    expect(parseJobResult("producer.chat", { ...chat, numTurns: -1 }).success).toBe(false);
  });

  it("keeps payload and result types tied to the job type", () => {
    const parsed = parseJobPayload("producer.chat", chatPayload);
    if (parsed.success) {
      expectTypeOf(parsed.data.producerSessionId).toEqualTypeOf<string | undefined>();
    }
    expectTypeOf<JobPayload<"producer.chat">["text"]>().toEqualTypeOf<string>();
    expectTypeOf<JobResult<"system.ping">["producerAvailable"]>().toEqualTypeOf<boolean>();
  });
});

describe("mcp project tools", () => {
  it("names each tool after its key and requires a known scope", () => {
    for (const [key, tool] of Object.entries(projectTools)) {
      expect(tool.name).toBe(key);
      expect(TOKEN_SCOPES).toContain(tool.scope);
    }
    expect(projectTools["project.create"].scope).toBe("mcp:write");
    expect(projectTools["project.list"].scope).toBe("mcp:read");
  });

  it("validates create input and output", () => {
    const { input, output } = projectTools["project.create"];

    expect(input.parse({ name: "  Rust in 60 seconds " })).toEqual({ name: "Rust in 60 seconds" });
    expect(input.safeParse({ name: "Rust", slug: "Not A Slug" }).success).toBe(false);
    const created = {
      project: {
        id: project.id,
        slug: project.slug,
        name: project.name,
        description: null,
        url: `https://loomcast.example.test/projects/${project.id}`,
      },
    };
    expect(output.parse(created)).toEqual(created);
    expect(output.safeParse({ project: { ...created.project, url: "not a url" } }).success).toBe(
      false,
    );
  });

  it("validates get and list input and output", () => {
    const get = projectTools["project.get"];
    const list = projectTools["project.list"];
    const stats = { conversations: 2, kbEntries: 0, items: 0 };

    expect(get.input.safeParse({ idOrSlug: "" }).success).toBe(false);
    expect(get.output.parse({ project, stats })).toEqual({ project, stats });
    expect(list.input.parse({})).toEqual({});
    expect(list.input.safeParse({ status: "deleted" }).success).toBe(false);
    expect(list.output.parse({ projects: [project] })).toEqual({ projects: [project] });
  });
});
