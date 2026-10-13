import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFunction } from "../src/producer/sdk-runtime";

// Message fixtures shaped like the producer runtime's stream. Only the fields the runtime reads are
// filled in, so each is cast to `SDKMessage`.

export const SESSION_ID = "8f14e45f-ceea-4672-9b6d-0b3a1c2d3e4f";

export function initMessage(sessionId = SESSION_ID): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: "/tmp",
    tools: [],
    model: "test-model",
    permissionMode: "default",
  } as unknown as SDKMessage;
}

export function textDelta(text: string): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  } as unknown as SDKMessage;
}

export function assistantText(text: string, error?: string): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    ...(error === undefined ? {} : { error }),
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SDKMessage;
}

export function assistantToolUse(name: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name, input }],
    },
  } as unknown as SDKMessage;
}

export function successResult(
  result: string,
  overrides: Record<string, unknown> = {},
  sessionId = SESSION_ID,
): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    result,
    num_turns: 2,
    duration_ms: 1234,
    duration_api_ms: 1000,
    total_cost_usd: 0.0125,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    },
    modelUsage: {},
    permission_denials: [],
    ...overrides,
  } as unknown as SDKMessage;
}

export function errorResult(subtype: string, errors: string[]): SDKMessage {
  return {
    type: "result",
    subtype,
    session_id: SESSION_ID,
    is_error: true,
    errors,
    num_turns: 0,
    duration_ms: 5,
    duration_api_ms: 0,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage;
}

export interface FakeQuery {
  readonly query: QueryFunction;
  readonly calls: { prompt: string; options: Options }[];
  closed: number;
}

/** A query function whose stream is produced by `script` for each call. */
export function fakeQuery(
  script: (options: Options) => AsyncGenerator<SDKMessage, void> | SDKMessage[],
): FakeQuery {
  const fake: FakeQuery = {
    calls: [],
    closed: 0,
    query: (params) => {
      fake.calls.push(params);
      const produced = script(params.options);
      const stream = Array.isArray(produced) ? fromArray(produced) : produced;
      return Object.assign(stream, {
        close: () => {
          fake.closed += 1;
        },
      });
    },
  };
  return fake;
}

async function* fromArray(messages: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  for (const message of messages) {
    yield message;
  }
}
