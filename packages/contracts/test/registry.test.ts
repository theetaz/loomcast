import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ALIGNMENT_MAX_WORDS,
  allowsEventKind,
  BRIDGE_LIMITS,
  CONCURRENCY_CLASSES,
  DEFAULT_FORMAT_RULES,
  isJobType,
  JOB_EVENT_KINDS,
  JOB_TYPES,
  type JobPayload,
  type JobResult,
  jobRegistry,
  MAX_TRANSCRIPT_LENGTH,
  MCP_ACCESS_LEVELS,
  MCP_ACCESS_SCOPES,
  parseJobPayload,
  parseJobResult,
  projectTools,
  TOKEN_SCOPES,
} from "../src";
import { alignment, analysis, ids, project, script, storyboard } from "./fixtures";

const PRODUCTION_JOB_TYPES = [
  "content.write_script",
  "content.storyboard",
  "content.revise",
  "content.voice",
  "content.render",
  "skills.sync",
] as const;

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
    expect(MCP_ACCESS_LEVELS).toContain(definition.mcpAccess);
  });

  it("grants MCP access only where a producer session needs it", () => {
    const access = Object.fromEntries(JOB_TYPES.map((type) => [type, jobRegistry[type].mcpAccess]));

    expect(access).toEqual({
      "system.ping": "none",
      "producer.chat": "read_write",
      "kb.analyze_reference": "read",
      "content.write_script": "read_write",
      "content.storyboard": "read_write",
      "content.revise": "read_write",
      "content.voice": "read_write",
      "content.render": "read_write",
      "skills.sync": "read",
    });
    expect(MCP_ACCESS_SCOPES).toEqual({
      none: [],
      read: ["mcp:read"],
      read_write: ["mcp:read", "mcp:write"],
    });
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
    expect(
      parseJobPayload("producer.chat", { ...chatPayload, contentItemId: ids.item }).success,
    ).toBe(true);
    expect(
      parseJobPayload("producer.chat", { ...chatPayload, contentItemId: "item-1" }).success,
    ).toBe(false);
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

  describe("kb.analyze_reference", () => {
    const payload = {
      projectId: ids.project,
      entryId: ids.entry,
      url: "https://instagram.com/reel/abc/",
      platform: "instagram",
      transcript: "Stop scrolling. Here is the trick.",
      likedReason: "The cold open",
    };

    it("is a requeued producer job with read-only MCP access", () => {
      const analyze = jobRegistry["kb.analyze_reference"];

      expect(analyze.timeoutMs).toBe(15 * 60 * 1000);
      expect(analyze.retry).toEqual({ maxAttempts: 2, onLeaseExpiry: "requeue" });
      expect(analyze.concurrencyClass).toBe("producer");
      expect([...analyze.durableEventKinds].sort()).toEqual(
        ["log", "session", "status", "tool.activity", "usage"].sort(),
      );
      expect(allowsEventKind("kb.analyze_reference", "assistant.message")).toBe(false);
    });

    it("validates its payload", () => {
      const { likedReason: _likedReason, ...withoutReason } = payload;

      expect(parseJobPayload("kb.analyze_reference", payload).success).toBe(true);
      expect(parseJobPayload("kb.analyze_reference", withoutReason).success).toBe(true);
      expect(
        parseJobPayload("kb.analyze_reference", { ...payload, transcript: undefined }).success,
      ).toBe(false);
      expect(
        parseJobPayload("kb.analyze_reference", {
          ...payload,
          transcript: undefined,
          mediaAssetId: ids.asset,
        }).success,
      ).toBe(true);
      expect(
        parseJobPayload("kb.analyze_reference", { ...payload, mediaAssetId: ids.asset }).success,
      ).toBe(true);
      expect(
        parseJobPayload("kb.analyze_reference", {
          ...payload,
          transcript: "x".repeat(MAX_TRANSCRIPT_LENGTH + 1),
        }).success,
      ).toBe(false);
      expect(
        parseJobPayload("kb.analyze_reference", { ...payload, url: "file:///etc/passwd" }).success,
      ).toBe(false);
      expect(
        parseJobPayload("kb.analyze_reference", { ...payload, platform: "vimeo" }).success,
      ).toBe(false);
    });

    it("validates its result and caps the summary", () => {
      const result = { analysis, summaryMd: "**Hook:** result first." };

      expect(parseJobResult("kb.analyze_reference", result).success).toBe(true);
      expect(
        parseJobResult("kb.analyze_reference", { ...result, transcript: "Spoken words." }).success,
      ).toBe(true);
      expect(
        parseJobResult("kb.analyze_reference", { ...result, summaryMd: "x".repeat(4_001) }).success,
      ).toBe(false);
      expect(parseJobResult("kb.analyze_reference", { ...result, summaryMd: " " }).success).toBe(
        false,
      );
      expect(
        parseJobResult("kb.analyze_reference", { ...result, analysis: { hook: analysis.hook } })
          .success,
      ).toBe(false);
    });
  });

  it("keeps payload and result types tied to the job type", () => {
    const parsed = parseJobPayload("producer.chat", chatPayload);
    if (parsed.success) {
      expectTypeOf(parsed.data.producerSessionId).toEqualTypeOf<string | undefined>();
    }
    expectTypeOf<JobPayload<"producer.chat">["text"]>().toEqualTypeOf<string>();
    expectTypeOf<JobResult<"system.ping">["producerAvailable"]>().toEqualTypeOf<boolean>();
    expectTypeOf<JobPayload<"kb.analyze_reference">["likedReason"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<JobResult<"kb.analyze_reference">["summaryMd"]>().toEqualTypeOf<string>();
    expectTypeOf<JobPayload<"kb.analyze_reference">["transcript"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<JobPayload<"content.voice">["voice"]["voiceId"]>().toEqualTypeOf<string>();
    expectTypeOf<JobResult<"content.render">["posterAssetId"]>().toEqualTypeOf<string>();
    expectTypeOf<JobResult<"skills.sync">["synced"][number]["version"]>().toEqualTypeOf<number>();
  });

  describe("production jobs", () => {
    const base = {
      projectId: ids.project,
      itemId: ids.item,
      versionId: ids.version,
      format: { formatVersionId: ids.formatVersion, rules: DEFAULT_FORMAT_RULES },
    };

    it("follows the job table", () => {
      const table = Object.fromEntries(
        PRODUCTION_JOB_TYPES.map((type) => {
          const { concurrencyClass, timeoutMs, retry } = jobRegistry[type];
          return [
            type,
            [concurrencyClass, timeoutMs / 60_000, retry.maxAttempts, retry.onLeaseExpiry],
          ];
        }),
      );

      expect(table).toEqual({
        "content.write_script": ["producer", 20, 2, "requeue"],
        "content.storyboard": ["producer", 20, 2, "requeue"],
        "content.revise": ["producer", 20, 1, "fail"],
        "content.voice": ["render", 10, 3, "requeue"],
        "content.render": ["render", 45, 2, "requeue"],
        "skills.sync": ["render", 5, 3, "requeue"],
      });
    });

    it("lets producer steps stream tool activity but not chat replies", () => {
      for (const type of [
        "content.write_script",
        "content.storyboard",
        "content.revise",
      ] as const) {
        expect(allowsEventKind(type, "tool.activity")).toBe(true);
        expect(allowsEventKind(type, "assistant.message")).toBe(false);
      }
      for (const type of ["content.voice", "content.render", "skills.sync"] as const) {
        expect([...jobRegistry[type].durableEventKinds].sort()).toEqual(["log", "status"]);
      }
    });

    it("carries ids and a format snapshot, never artifacts", () => {
      expect(parseJobPayload("content.write_script", base).success).toBe(true);
      expect(parseJobPayload("content.storyboard", base).success).toBe(true);
      expect(
        parseJobPayload("content.write_script", {
          ...base,
          format: { formatVersionId: null, rules: DEFAULT_FORMAT_RULES },
        }).success,
      ).toBe(true);
      expect(parseJobPayload("content.write_script", { ...base, format: undefined }).success).toBe(
        false,
      );
      expect(
        parseJobPayload("content.write_script", {
          ...base,
          format: {
            ...base.format,
            rules: { ...DEFAULT_FORMAT_RULES, lengthSec: { min: 9, max: 6 } },
          },
        }).success,
      ).toBe(false);
      expect(parseJobPayload("content.storyboard", { ...base, script }).data).not.toHaveProperty(
        "script",
      );
    });

    it("validates voice, render and revise payloads", () => {
      expect(
        parseJobPayload("content.voice", { ...base, voice: { voiceId: "voice-1", speed: 1.1 } })
          .success,
      ).toBe(true);
      expect(parseJobPayload("content.voice", base).success).toBe(false);
      expect(
        parseJobPayload("content.voice", { ...base, voice: { voiceId: "voice-1", speed: 2 } })
          .success,
      ).toBe(false);
      expect(parseJobPayload("content.render", { ...base, voiceAssetId: ids.voice }).success).toBe(
        true,
      );
      expect(parseJobPayload("content.render", base).success).toBe(false);
      expect(parseJobPayload("content.revise", base).success).toBe(true);
      expect(
        parseJobPayload("content.revise", {
          ...base,
          reviewId: ids.review,
          instructions: "Open on the error message.",
        }).success,
      ).toBe(true);
      expect(parseJobPayload("content.revise", { ...base, instructions: " " }).success).toBe(false);
    });

    it("validates production results", () => {
      expect(parseJobResult("content.write_script", { script }).success).toBe(true);
      expect(
        parseJobResult("content.write_script", { script: { ...script, segments: [] } }).success,
      ).toBe(false);
      expect(parseJobResult("content.storyboard", { storyboard }).success).toBe(true);
      expect(parseJobResult("content.revise", { script, summary: "Shorter hook." }).success).toBe(
        true,
      );
      expect(parseJobResult("content.revise", { summary: "Nothing changed." }).success).toBe(false);
      expect(
        parseJobResult("content.voice", { voiceAssetId: ids.voice, durationMs: 41_000, alignment })
          .success,
      ).toBe(true);
      expect(
        parseJobResult("content.render", {
          renderAssetId: ids.render,
          posterAssetId: ids.poster,
          durationMs: 41_000,
          width: 1080,
          height: 1920,
        }).success,
      ).toBe(true);
      expect(
        parseJobResult("content.render", { renderAssetId: ids.render, durationMs: 41_000 }).success,
      ).toBe(false);
    });

    it("syncs all skills or the named ones", () => {
      expect(parseJobPayload("skills.sync", {}).success).toBe(true);
      expect(parseJobPayload("skills.sync", { names: ["scriptwriting"] }).success).toBe(true);
      expect(parseJobPayload("skills.sync", { names: [] }).success).toBe(false);
      expect(parseJobPayload("skills.sync", { names: ["a", "a"] }).success).toBe(false);
      expect(parseJobPayload("skills.sync", { names: ["../a"] }).success).toBe(false);
      expect(
        parseJobResult("skills.sync", { synced: [{ name: "scriptwriting", version: 3 }] }).success,
      ).toBe(true);
      expect(parseJobResult("skills.sync", { synced: [{ name: "x", version: 0 }] }).success).toBe(
        false,
      );
    });

    it("keeps a voice result within one bridge frame", () => {
      const words = Array.from({ length: ALIGNMENT_MAX_WORDS }, (_, index) => ({
        text: "pneumonoultramicroscopic",
        startMs: index * 100,
        endMs: index * 100 + 90,
      }));
      const result = { voiceAssetId: ids.voice, durationMs: 600_000, alignment: { words } };

      expect(parseJobResult("content.voice", result).success).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThan(BRIDGE_LIMITS.maxPayloadBytes);
    });
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
