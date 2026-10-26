import { describe, expect, it } from "vitest";
import {
  type AgentToServerDraft,
  AgentToServerSchema,
  type AgentToServerType,
  BRIDGE_LIMITS,
  BridgeEncodeError,
  CLOSE_CODES,
  createUlid,
  encode,
  JOB_TOKEN_RE,
  MAX_TRANSCRIPT_LENGTH,
  MCP_PATH,
  parseAgentMessage,
  parseServerMessage,
  type ServerToAgentDraft,
  ServerToAgentSchema,
  type ServerToAgentType,
  ULID_RE,
  utf8ByteLength,
} from "../src";
import { at, ids } from "./fixtures";

const now = new Date(at);

/** One draft per agent message type; the mapped type makes a missing type a compile error. */
const agentDrafts: { [T in AgentToServerType]: Extract<AgentToServerDraft, { type: T }> } = {
  hello: {
    type: "hello",
    payload: {
      protocol: 1,
      agentVersion: "0.1.0",
      platform: "darwin-arm64",
      jobTypes: ["system.ping", "producer.chat"],
      credits: { producer: 1, render: 1 },
      resume: [{ jobId: ids.job, lastAckedSeq: 4 }],
    },
  },
  "job.accept": { type: "job.accept", payload: { jobId: ids.job } },
  "job.reject": { type: "job.reject", payload: { jobId: ids.job, reason: "no_credits" } },
  "job.event": {
    type: "job.event",
    payload: {
      jobId: ids.job,
      seq: 5,
      kind: "tool.activity",
      data: { tool: "Read", summary: "Reading PROJECT.md" },
    },
  },
  "job.stream": {
    type: "job.stream",
    payload: { jobId: ids.job, kind: "assistant.delta", text: "Here are three hooks" },
  },
  "job.heartbeat": { type: "job.heartbeat", payload: { jobIds: [ids.job] } },
  "job.complete": {
    type: "job.complete",
    payload: {
      jobId: ids.job,
      result: { sdkSessionId: "session-1", finalText: "Done.", numTurns: 2, durationMs: 4210 },
    },
  },
  "job.fail": {
    type: "job.fail",
    payload: {
      jobId: ids.job,
      error: { code: "cancelled", message: "Cancelled", retryable: false },
    },
  },
  credits: { type: "credits", payload: { producer: 0, render: 1 } },
};

const serverDrafts: { [T in ServerToAgentType]: Extract<ServerToAgentDraft, { type: T }> } = {
  "hello.ok": {
    type: "hello.ok",
    payload: {
      deviceId: ids.device,
      serverTime: at,
      heartbeatMs: 20_000,
      leaseMs: 600_000,
      limits: { maxPayloadBytes: 1_048_576, maxStreamTextLength: 32_768 },
    },
  },
  "job.assign": {
    type: "job.assign",
    payload: {
      job: {
        id: ids.job,
        type: "producer.chat",
        attempt: 1,
        payload: { text: "Hi" },
        workspaceId: ids.workspace,
        conversationId: ids.conversation,
      },
      leaseMs: 600_000,
    },
  },
  "job.cancel": { type: "job.cancel", payload: { jobId: ids.job } },
  ack: { type: "ack", payload: { jobId: ids.job, upToSeq: 5 } },
  error: { type: "error", payload: { code: "rate_limited", message: "Slow down" } },
};

function unionTypes(options: readonly { shape: { type: { value: string } } }[]): string[] {
  return options.map((option) => option.shape.type.value).sort();
}

describe("bridge round trips", () => {
  it("has a sample for every message type in both unions", () => {
    expect(Object.keys(agentDrafts).sort()).toEqual(unionTypes(AgentToServerSchema.options));
    expect(Object.keys(serverDrafts).sort()).toEqual(unionTypes(ServerToAgentSchema.options));
  });

  it.each(Object.values(agentDrafts))("round-trips agent message $type", (draft) => {
    const parsed = parseAgentMessage(encode(draft, now));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message).toMatchObject({
      v: 1,
      type: draft.type,
      ts: at,
      payload: draft.payload,
    });
    expect(parsed.message.id).toMatch(ULID_RE);
  });

  it.each(Object.values(serverDrafts))("round-trips server message $type", (draft) => {
    const parsed = parseServerMessage(encode(draft, now));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message).toMatchObject({
      v: 1,
      type: draft.type,
      ts: at,
      payload: draft.payload,
    });
  });

  it("keeps a given id, timestamp and ref", () => {
    const id = createUlid(now.getTime());
    const ref = createUlid(now.getTime());
    const frame = encode({ ...agentDrafts["job.accept"], id, ts: at, ref });

    expect(JSON.parse(frame)).toEqual({
      v: 1,
      id,
      type: "job.accept",
      ts: at,
      ref,
      payload: { jobId: ids.job },
    });
  });

  it("drops unknown payload fields", () => {
    const frame = JSON.stringify({
      v: 1,
      id: createUlid(),
      type: "job.cancel",
      ts: at,
      payload: { jobId: ids.job, command: "rm -rf /" },
    });
    const parsed = parseServerMessage(frame);

    expect(parsed.ok && parsed.message.payload).toEqual({ jobId: ids.job });
  });
});

describe("bridge parsing", () => {
  function frame(type: string, payload: object, extra: object = {}): string {
    return JSON.stringify({ v: 1, id: createUlid(), type, ts: at, payload, ...extra });
  }

  it("rejects unknown envelope types", () => {
    const agent = parseAgentMessage(frame("job.shell", { command: "ls" }));
    const server = parseServerMessage(frame("job.run", { jobId: ids.job }));

    for (const result of [agent, server]) {
      expect(result).toMatchObject({
        ok: false,
        reason: "invalid_message",
        closeCode: CLOSE_CODES.malformedMessage,
      });
    }
  });

  it("rejects messages sent in the wrong direction", () => {
    expect(parseServerMessage(encode(agentDrafts["job.accept"])).ok).toBe(false);
    expect(parseAgentMessage(encode(serverDrafts.ack)).ok).toBe(false);
  });

  it("rejects over-long stream text", () => {
    const text = "x".repeat(BRIDGE_LIMITS.maxStreamTextLength + 1);
    const result = parseAgentMessage(
      frame("job.stream", { jobId: ids.job, kind: "assistant.delta", text }),
    );

    expect(result).toMatchObject({ ok: false, reason: "invalid_message" });
    expect(!result.ok && result.issues[0]?.path).toEqual(["payload", "text"]);
  });

  it("rejects frames over the payload limit before parsing them", () => {
    const padding = "é".repeat(BRIDGE_LIMITS.maxPayloadBytes / 2);
    const result = parseAgentMessage(frame("job.heartbeat", { jobIds: [] }, { padding }));

    expect(result).toMatchObject({ ok: false, reason: "too_large", closeCode: 4400 });
  });

  it("rejects invalid JSON", () => {
    expect(parseAgentMessage("{not json")).toMatchObject({ ok: false, reason: "invalid_json" });
  });

  it("reports an unsupported protocol version with close code 4426", () => {
    const result = parseAgentMessage(frame("credits", { producer: 1, render: 1 }, { v: 2 }));

    expect(result).toMatchObject({
      ok: false,
      reason: "unsupported_version",
      closeCode: CLOSE_CODES.unsupportedProtocol,
    });
  });

  it("rejects a hello for another protocol version", () => {
    const hello = { ...agentDrafts.hello.payload, protocol: 2 };

    expect(parseAgentMessage(frame("hello", hello)).ok).toBe(false);
  });

  it("rejects envelopes with a malformed id, timestamp or payload", () => {
    const payload = { jobId: ids.job };

    expect(parseAgentMessage(frame("job.accept", payload, { id: "42" })).ok).toBe(false);
    expect(parseAgentMessage(frame("job.accept", payload, { ts: "yesterday" })).ok).toBe(false);
    expect(parseAgentMessage(frame("job.accept", [])).ok).toBe(false);
    expect(parseAgentMessage("[]").ok).toBe(false);
  });

  it("validates durable event data against its kind", () => {
    const event = { jobId: ids.job, seq: 1, kind: "session", data: { tool: "Read", summary: "" } };

    expect(parseAgentMessage(frame("job.event", event)).ok).toBe(false);
    expect(parseAgentMessage(frame("job.event", { ...event, kind: "debug.dump" })).ok).toBe(false);
    expect(parseAgentMessage(frame("job.event", { ...event, kind: "tool.activity" })).ok).toBe(
      true,
    );
  });

  it("rejects durable events with a sequence number below 1", () => {
    const event = { jobId: ids.job, seq: 0, kind: "log", data: { level: "info", message: "hi" } };

    expect(parseAgentMessage(frame("job.event", event)).ok).toBe(false);
  });
});

describe("encode", () => {
  it("throws on a message the receiver would reject", () => {
    const text = "x".repeat(BRIDGE_LIMITS.maxStreamTextLength + 1);
    const draft: AgentToServerDraft = {
      type: "job.stream",
      payload: { jobId: ids.job, kind: "assistant.delta", text },
    };

    expect(() => encode(draft)).toThrow(BridgeEncodeError);
  });

  it("throws on a frame over the payload limit", () => {
    const output = "€".repeat(400_000);
    const draft: AgentToServerDraft = {
      type: "job.complete",
      payload: { jobId: ids.job, result: { output } },
    };

    expect(() => encode(draft)).toThrow(/limit/);
  });
});

describe("createUlid", () => {
  it("encodes the time and 80 random bits in Crockford base32", () => {
    const zeros = () => new Uint8Array(16);
    const ones = () => new Uint8Array(16).fill(255);

    expect(createUlid(0, zeros)).toBe("00000000000000000000000000");
    expect(createUlid(1_469_918_176_385, zeros)).toBe("01ARYZ6S410000000000000000");
    expect(createUlid(0, ones)).toBe("0000000000ZZZZZZZZZZZZZZZZ");
  });

  it("creates distinct valid ids with the platform random source", () => {
    const first = createUlid();
    const second = createUlid();

    expect(first).toMatch(ULID_RE);
    expect(second).toMatch(ULID_RE);
    expect(first).not.toBe(second);
  });
});

describe("utf8ByteLength", () => {
  it.each([
    ["", 0],
    ["abc", 3],
    ["é", 2],
    ["€", 3],
    ["😀", 4],
    ["\ud800", 3],
  ])("counts %j as %i bytes", (text, bytes) => {
    expect(utf8ByteLength(text)).toBe(bytes);
  });
});

describe("job.assign credentials", () => {
  const token = `lc_job_${"aZ09".repeat(10)}xyz`;
  const credentials = { mcp: { endpoint: MCP_PATH, token, expiresAt: at } };
  const assign = serverDrafts["job.assign"];

  function withCredentials(value: unknown): string {
    return JSON.stringify({
      v: 1,
      id: createUlid(),
      type: "job.assign",
      ts: at,
      payload: { ...assign.payload, credentials: value },
    });
  }

  it("round-trips a job.assign with credentials", () => {
    const draft: ServerToAgentDraft = {
      type: "job.assign",
      payload: { ...assign.payload, credentials },
    };
    const parsed = parseServerMessage(encode(draft, now));

    expect(token).toMatch(JOB_TOKEN_RE);
    expect(parsed.ok && parsed.message.type === "job.assign" && parsed.message.payload).toEqual({
      ...assign.payload,
      job: { ...assign.payload.job, projectId: assign.payload.job.workspaceId },
      credentials,
    });
  });

  it("sends the workspace as projectId too, for agents built before the rename", () => {
    const frame = JSON.parse(encode({ type: "job.assign", payload: assign.payload }, now));
    expect(frame.payload.job.projectId).toBe(assign.payload.job.workspaceId);
  });

  it("accepts a job from a server built before the rename, which names only projectId", () => {
    const frame = JSON.stringify({
      v: 1,
      id: createUlid(),
      type: "job.assign",
      ts: at,
      payload: {
        job: {
          id: ids.job,
          type: "producer.chat",
          attempt: 1,
          payload: { conversationId: ids.conversation, projectId: ids.workspace, text: "Hi" },
          projectId: ids.workspace,
        },
        leaseMs: 600_000,
      },
    });
    const parsed = parseServerMessage(frame);
    expect(
      parsed.ok && parsed.message.type === "job.assign" && parsed.message.payload.job,
    ).toMatchObject({
      workspaceId: ids.workspace,
      payload: { workspaceId: ids.workspace },
    });
  });

  it("still parses an old-style job.assign without credentials", () => {
    const frame = JSON.stringify({
      v: 1,
      id: createUlid(),
      type: "job.assign",
      ts: at,
      payload: {
        job: {
          id: ids.job,
          type: "system.ping",
          attempt: 1,
          payload: {},
          workspaceId: ids.workspace,
        },
        leaseMs: 600_000,
      },
    });
    const parsed = parseServerMessage(frame);

    expect(parsed.ok).toBe(true);
    expect(
      parsed.ok && parsed.message.type === "job.assign" && parsed.message.payload,
    ).not.toHaveProperty("credentials");
  });

  it.each([
    ["a device token", { ...credentials.mcp, token: `lc_dev_${"aZ09".repeat(10)}xyz` }],
    ["a user MCP token", { ...credentials.mcp, token: `lc_mcp_${"aZ09".repeat(10)}xyz` }],
    ["a short token", { ...credentials.mcp, token: `lc_job_${"s".repeat(5)}` }],
    ["an absolute URL", { ...credentials.mcp, endpoint: "https://evil.example/mcp" }],
    ["a protocol-relative URL", { ...credentials.mcp, endpoint: "//evil.example/mcp" }],
    ["a backslash path", { ...credentials.mcp, endpoint: "/\\evil.example/mcp" }],
    ["a relative path", { ...credentials.mcp, endpoint: "mcp" }],
    ["a missing expiry", { endpoint: MCP_PATH, token }],
  ])("rejects credentials with %s", (_name, mcp) => {
    expect(parseServerMessage(withCredentials({ mcp })).ok).toBe(false);
  });

  it("rejects credentials without an mcp entry", () => {
    expect(parseServerMessage(withCredentials({})).ok).toBe(false);
  });

  it("fits the longest analysis payload with credentials in one frame", () => {
    const draft: ServerToAgentDraft = {
      type: "job.assign",
      payload: {
        job: {
          id: ids.job,
          type: "kb.analyze_reference",
          attempt: 1,
          payload: {
            workspaceId: ids.workspace,
            entryId: ids.job,
            url: `https://example.com/${"a".repeat(2_000)}`,
            platform: "other",
            transcript: "€".repeat(MAX_TRANSCRIPT_LENGTH),
            likedReason: "€".repeat(2_000),
          },
          workspaceId: ids.workspace,
        },
        leaseMs: 600_000,
        credentials,
      },
    };

    expect(() => encode(draft)).not.toThrow();
  });
});
