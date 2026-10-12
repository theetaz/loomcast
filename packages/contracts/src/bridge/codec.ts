import { z } from "zod";
import { createUlid } from "../util/ulid";
import { utf8ByteLength } from "../util/utf8";
import { type AgentToServer, AgentToServerSchema } from "./agent-to-server";
import { BRIDGE_LIMITS, CLOSE_CODES, type CloseCode, PROTOCOL_VERSION } from "./constants";
import { type ServerToAgent, ServerToAgentSchema } from "./server-to-agent";

export type BridgeMessage = AgentToServer | ServerToAgent;

/** A message before `encode` stamps it: `v` is added, and `id` and `ts` are optional. */
type Draft<M> = M extends { type: string; payload: unknown }
  ? { type: M["type"]; payload: M["payload"]; ref?: string; id?: string; ts?: string }
  : never;

export type AgentToServerDraft = Draft<AgentToServer>;
export type ServerToAgentDraft = Draft<ServerToAgent>;
export type BridgeMessageDraft = AgentToServerDraft | ServerToAgentDraft;

const BridgeMessageSchema = z.discriminatedUnion("type", [
  ...AgentToServerSchema.options,
  ...ServerToAgentSchema.options,
]);

type Issues = z.ZodError["issues"];

/** Thrown by `encode` for a message that would be rejected by the receiving side. */
export class BridgeEncodeError extends Error {
  override readonly name = "BridgeEncodeError";
  readonly issues: Issues;

  constructor(message: string, issues: Issues = []) {
    super(message);
    this.issues = issues;
  }
}

/**
 * Stamps a message with the protocol version, a new ULID `id` and the current time (unless the
 * draft carries them), validates it and serialises it into one text frame.
 *
 * Throws `BridgeEncodeError` when the message is invalid or larger than `maxPayloadBytes`, so a
 * sender never makes the other side close the socket.
 */
export function encode(draft: BridgeMessageDraft, now: Date = new Date()): string {
  const result = BridgeMessageSchema.safeParse({
    v: PROTOCOL_VERSION,
    id: draft.id ?? createUlid(now.getTime()),
    type: draft.type,
    ts: draft.ts ?? now.toISOString(),
    ref: draft.ref,
    payload: draft.payload,
  });
  if (!result.success) {
    throw new BridgeEncodeError(`Invalid "${draft.type}" message`, result.error.issues);
  }
  const frame = JSON.stringify(result.data);
  const bytes = utf8ByteLength(frame);
  if (bytes > BRIDGE_LIMITS.maxPayloadBytes) {
    throw new BridgeEncodeError(
      `"${draft.type}" message is ${bytes} bytes; the limit is ${BRIDGE_LIMITS.maxPayloadBytes}`,
    );
  }
  return frame;
}

export type ParseFailureReason =
  | "too_large"
  | "invalid_json"
  | "unsupported_version"
  | "invalid_message";

export interface ParseFailure {
  ok: false;
  reason: ParseFailureReason;
  message: string;
  /** The code to close the socket with when the failure is fatal for the connection. */
  closeCode: CloseCode;
  issues: Issues;
}

export type ParseResult<M> = { ok: true; message: M } | ParseFailure;

/** Parses and validates one frame sent by the studio agent. */
export function parseAgentMessage(frame: string): ParseResult<AgentToServer> {
  return parseFrame(AgentToServerSchema, frame);
}

/** Parses and validates one frame sent by the server. */
export function parseServerMessage(frame: string): ParseResult<ServerToAgent> {
  return parseFrame(ServerToAgentSchema, frame);
}

function parseFrame<M>(schema: z.ZodType<M>, frame: string): ParseResult<M> {
  if (utf8ByteLength(frame) > BRIDGE_LIMITS.maxPayloadBytes) {
    return failure("too_large", "Frame exceeds the payload limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return failure("invalid_json", "Frame is not valid JSON");
  }
  if (isObject(value) && typeof value.v === "number" && value.v !== PROTOCOL_VERSION) {
    return failure(
      "unsupported_version",
      `Protocol version ${value.v} is not supported; expected ${PROTOCOL_VERSION}`,
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    return failure("invalid_message", "Frame does not match the protocol", result.error.issues);
  }
  return { ok: true, message: result.data };
}

function failure(reason: ParseFailureReason, message: string, issues: Issues = []): ParseFailure {
  const closeCode =
    reason === "unsupported_version"
      ? CLOSE_CODES.unsupportedProtocol
      : CLOSE_CODES.malformedMessage;
  return { ok: false, reason, message, closeCode, issues };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
