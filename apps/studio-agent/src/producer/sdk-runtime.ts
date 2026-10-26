import {
  type HookCallback,
  type Options,
  type SDKAssistantMessage,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { BRIDGE_TIMINGS, type JobEventData, MAX_ASSISTANT_TEXT_LENGTH } from "@loomcast/contracts";
import { AGENT_VERSION } from "../agent-info";
import { type Logger, silentLogger } from "../logger";
import type { SkillPackEntry } from "../production/skills";
import { summarizeToolUse } from "./activity";
import { deniedMcpTools, mcpServersFor } from "./mcp";
import {
  builtinToolsFor,
  checkToolUse,
  createToolGuard,
  deniedBuiltinTools,
  type ToolGuardOptions,
} from "./permissions";
import { chatBrief } from "./prompts/chat";
import {
  PRODUCER_ERROR_CODES,
  ProducerError,
  type ProducerEvent,
  type ProducerRunInput,
  type ProducerRunResult,
  type ProducerRuntime,
  producerNotAuthenticated,
} from "./runtime";

/** The part of the runtime's `query` this module uses; tests pass a fake message stream. */
export type QueryFunction = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage> & { close?: () => void };

export interface SdkProducerRuntimeOptions {
  /** Defaults to the runtime's `query`. */
  readonly query?: QueryFunction;
  /** The environment the session starts from; API-key variables are always removed. */
  readonly env?: NodeJS.ProcessEnv;
  /** Directories no tool may read, such as the agent's state directory. */
  readonly protectedDirs?: readonly string[];
  /** How long streamed text is collected before it is passed on. */
  readonly deltaBatchMs?: number;
  readonly log?: Logger;
}

/** The default brief: the chat brief without a workspace. */
export const PRODUCER_BRIEF = chatBrief();

/**
 * Tools removed outright, in addition to limiting the base set to the job type's tools. Bash is
 * removed through `deniedBuiltinTools` for every job type that does not get it.
 */
const REMOVED_TOOLS = ["NotebookEdit", "Agent", "Task", "Skill"];

/**
 * Runs producer turns through the producer runtime package.
 *
 * - The session uses the Mac's logged-in subscription: API-key variables are stripped from its
 *   environment, and no code path reads or sets a key.
 * - It loads no user or workspace settings (`settingSources: []`) and no MCP configuration from
 *   disk (`strictMcpConfig`). The only MCP server is the platform's, attached with the job token
 *   when the job has MCP access.
 * - Its tools are limited to the job type's built-in tools; the other producer tools, Bash
 *   (except in storyboard sessions) and the platform MCP tools the job may not call are removed
 *   outright. Every permission prompt goes to the guard. `allowedTools` stays empty on purpose:
 *   an allowed tool would skip the guard.
 * - The same guard also runs as a `PreToolUse` hook, which fires for every tool call before the
 *   runtime's own permission rules. A call the guard denies is denied there even if the runtime
 *   would have approved it without asking, and an allowed Bash call runs in its rewritten form.
 * - The job's skill pack is appended to the system prompt after the brief.
 */
export class SdkProducerRuntime implements ProducerRuntime {
  readonly #query: QueryFunction;
  readonly #env: NodeJS.ProcessEnv;
  readonly #protectedDirs: readonly string[];
  readonly #deltaBatchMs: number;
  readonly #log: Logger;

  constructor(options: SdkProducerRuntimeOptions = {}) {
    this.#query = options.query ?? sdkQuery;
    this.#env = options.env ?? process.env;
    this.#protectedDirs = options.protectedDirs ?? [];
    this.#deltaBatchMs = options.deltaBatchMs ?? BRIDGE_TIMINGS.streamBatchMs;
    this.#log = options.log ?? silentLogger;
  }

  /** The options of one turn. Exposed for tests. */
  options(
    input: Pick<
      ProducerRunInput,
      "cwd" | "resumeId" | "jobType" | "mcp" | "brief" | "skills" | "commandScope"
    >,
    abort: AbortController,
  ): Options {
    const jobType = input.jobType ?? "producer.chat";
    const guard: ToolGuardOptions = {
      workspaceDir: input.cwd,
      protectedDirs: this.#protectedDirs,
      jobType,
      commandScope: input.commandScope,
    };
    return {
      cwd: input.cwd,
      ...(input.resumeId === undefined ? {} : { resume: input.resumeId }),
      abortController: abort,
      env: producerEnv(this.#env),
      settingSources: [],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: withSkillPack(input.brief ?? PRODUCER_BRIEF, input.skills ?? []),
      },
      tools: [...builtinToolsFor(jobType)],
      disallowedTools: [
        ...REMOVED_TOOLS,
        ...deniedBuiltinTools(jobType),
        ...deniedMcpTools(jobType),
      ],
      permissionMode: "default",
      canUseTool: createToolGuard(guard),
      hooks: { PreToolUse: [{ hooks: [preToolUseGuard(guard)] }] },
      mcpServers: mcpServersFor(input.mcp),
      strictMcpConfig: true,
      includePartialMessages: true,
    };
  }

  async run(input: ProducerRunInput): Promise<ProducerRunResult> {
    input.signal.throwIfAborted();
    const abort = new AbortController();
    const onAbort = (): void => abort.abort(input.signal.reason);
    input.signal.addEventListener("abort", onAbort, { once: true });

    const stderr = new TailBuffer(4_000);
    const deltas = new DeltaBatcher(this.#deltaBatchMs, input.onDelta);
    const turn = new TurnState(input, deltas);
    const options: Options = {
      ...this.options(input, abort),
      stderr: (data) => stderr.push(data),
    };

    const stream = this.#query({ prompt: input.prompt, options });
    try {
      for await (const message of stream) {
        turn.handle(message);
      }
    } catch (error) {
      if (input.signal.aborted) {
        throw input.signal.reason;
      }
      this.#log.warn("producer session failed", { error: errorText(error) });
      throw classifyFailure(turn.assistantError, [errorText(error), stderr.text()]);
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      deltas.flush();
      stream.close?.();
    }
    if (input.signal.aborted) {
      throw input.signal.reason;
    }
    return turn.finish();
  }
}

/** Follows the messages of one turn and turns them into durable events and the result. */
class TurnState {
  sessionId: string | undefined;
  assistantError: SDKAssistantMessageError | undefined;
  #result: SDKResultMessage | undefined;
  readonly #input: ProducerRunInput;
  readonly #deltas: DeltaBatcher;

  constructor(input: ProducerRunInput, deltas: DeltaBatcher) {
    this.#input = input;
    this.#deltas = deltas;
  }

  handle(message: SDKMessage): void {
    switch (message.type) {
      case "system":
        this.#system(message);
        return;
      case "stream_event":
        if (message.parent_tool_use_id === null) {
          const { event } = message;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            this.#deltas.push(event.delta.text);
          }
        }
        return;
      case "assistant":
        this.#assistant(message);
        return;
      case "auth_status":
        if (message.error !== undefined) {
          this.assistantError = "authentication_failed";
        }
        return;
      case "result":
        this.#result = message;
        this.#session(message.session_id);
        this.#emit({ kind: "usage", data: usageOf(message) });
        return;
      default:
        return;
    }
  }

  finish(): ProducerRunResult {
    const result = this.#result;
    if (result === undefined) {
      throw new ProducerError(
        PRODUCER_ERROR_CODES.failed,
        "The producer session ended without a result",
        true,
      );
    }
    if (result.subtype !== "success" || result.is_error) {
      const texts = result.subtype === "success" ? [result.result] : result.errors;
      throw classifyFailure(this.assistantError, texts);
    }
    return {
      sessionId: this.sessionId ?? result.session_id,
      finalText: truncate(result.result, MAX_ASSISTANT_TEXT_LENGTH),
      numTurns: Math.max(0, Math.trunc(result.num_turns)),
      durationMs: Math.max(0, result.duration_ms),
    };
  }

  #system(message: Extract<SDKMessage, { type: "system" }>): void {
    switch (message.subtype) {
      case "init":
        this.#session(message.session_id);
        this.#emit({ kind: "status", data: { state: "running" } });
        return;
      case "status":
        if (message.status === "compacting") {
          this.#emit({ kind: "status", data: { state: "compacting" } });
        }
        return;
      case "api_retry":
        this.#emit({
          kind: "status",
          data: {
            state: "retrying",
            message: `Retrying after ${message.error} (attempt ${message.attempt} of ${message.max_retries})`,
          },
        });
        return;
      default:
        return;
    }
  }

  #assistant(message: SDKAssistantMessage): void {
    if (message.parent_tool_use_id !== null) {
      return;
    }
    if (message.error !== undefined) {
      this.assistantError = message.error;
      return;
    }
    const texts: string[] = [];
    for (const block of message.message.content) {
      if (block.type === "text") {
        texts.push(block.text);
      } else if (block.type === "tool_use") {
        this.#emit({
          kind: "tool.activity",
          data: { tool: block.name, summary: summarizeToolUse(block.name, block.input, this.#cwd) },
        });
      }
    }
    const text = texts.join("");
    if (text.trim().length > 0) {
      // Deltas go out before the complete message that contains them.
      this.#deltas.flush();
      this.#emit({
        kind: "assistant.message",
        data: { text: truncate(text, MAX_ASSISTANT_TEXT_LENGTH) },
      });
    }
  }

  get #cwd(): string {
    return this.#input.cwd;
  }

  #session(sessionId: string): void {
    if (this.sessionId === undefined && sessionId.length > 0) {
      this.sessionId = sessionId;
      this.#emit({ kind: "session", data: { sessionId } });
    }
  }

  #emit(event: ProducerEvent): void {
    this.#input.onEvent(event);
  }
}

/**
 * The guard as a `PreToolUse` hook. It denies whatever the guard denies, before the runtime's own
 * permission rules run. An allowed Bash call is approved with the guard's rewritten input; every
 * other allowed call continues to the normal permission flow, which ends in `canUseTool`.
 */
export function preToolUseGuard(options: ToolGuardOptions): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return { continue: true };
    }
    const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
    const result = await checkToolUse(options, input.tool_name, toolInput, input.mcp_server);
    if (result.behavior === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.message,
        },
      };
    }
    if (input.tool_name === "Bash") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "An allow-listed command, rewritten by the studio agent",
          updatedInput: result.updatedInput ?? toolInput,
        },
      };
    }
    return { continue: true };
  };
}

/** The most skill text a session's system prompt gets. */
export const MAX_SKILL_PACK_CHARS = 120_000;

/**
 * The brief followed by the skill pack: each skill's description and files, in order. Skills that
 * no longer fit are named but left out.
 */
export function withSkillPack(brief: string, skills: readonly SkillPackEntry[]): string {
  if (skills.length === 0) {
    return brief;
  }
  const parts = [
    brief,
    "",
    "# Skill pack",
    "",
    "Loomcast production skills for this job. Follow them; the format rules and the instructions in the prompt take precedence where they differ.",
  ];
  let used = 0;
  const skipped: string[] = [];
  for (const skill of skills) {
    const body = [
      "",
      `## Skill: ${skill.name} (${skill.kind}${skill.version === undefined ? "" : `, version ${skill.version}`})`,
      "",
      skill.description,
      ...skill.files.flatMap((file) => [
        "",
        `### ${skill.name}/${file.path}`,
        "",
        file.content.trimEnd(),
      ]),
    ].join("\n");
    if (used + body.length > MAX_SKILL_PACK_CHARS) {
      skipped.push(skill.name);
      continue;
    }
    used += body.length;
    parts.push(body);
  }
  if (skipped.length > 0) {
    parts.push("", `Skills left out for length: ${skipped.join(", ")}.`);
  }
  return parts.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The session's environment: the agent's environment without API-key variables, so the runtime
 * uses the subscription the Mac is logged in with. Only variable names are inspected.
 */
export function producerEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !isStrippedVariable(name)) {
      env[name] = value;
    }
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `loomcast-studio-agent/${AGENT_VERSION}`;
  return env;
}

const STRIPPED_VARIABLES = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  // Set inside an interactive session of the runtime; a nested session must start fresh.
  "CLAUDECODE",
]);

function isStrippedVariable(name: string): boolean {
  return STRIPPED_VARIABLES.has(name.toUpperCase()) || /API_?KEY$/i.test(name);
}

const NOT_LOGGED_IN = /not logged in|please run \/login|invalid api key|oauth token has expired/i;
const SESSION_NOT_FOUND = /no conversation found|session .*not found/i;

/** Maps a failed turn to a job error. */
export function classifyFailure(
  assistantError: SDKAssistantMessageError | undefined,
  texts: readonly string[],
): ProducerError {
  const detail = texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
  if (assistantError === "authentication_failed" || NOT_LOGGED_IN.test(detail)) {
    return producerNotAuthenticated();
  }
  switch (assistantError) {
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "billing_error":
    case "verification_required":
      return new ProducerError(
        PRODUCER_ERROR_CODES.account,
        `The producer account on this Mac cannot run sessions (${assistantError})`,
        false,
      );
    case "rate_limit":
    case "overloaded":
    case "server_error":
      return new ProducerError(
        PRODUCER_ERROR_CODES.unavailable,
        `The producer service is unavailable (${assistantError}); try again later`,
        true,
      );
    default:
      break;
  }
  if (SESSION_NOT_FOUND.test(detail)) {
    return new ProducerError(
      PRODUCER_ERROR_CODES.sessionNotFound,
      "The producer session to resume was not found on this Mac",
      false,
    );
  }
  return new ProducerError(
    PRODUCER_ERROR_CODES.failed,
    truncate(detail.length > 0 ? detail : "The producer session failed", 1_000),
    false,
  );
}

function usageOf(result: SDKResultMessage): JobEventData<"usage"> {
  const models = Object.values(result.modelUsage ?? {});
  const costUsd = nonNegative(result.total_cost_usd);
  if (models.length > 0) {
    const sum = (pick: (usage: (typeof models)[number]) => number): number | undefined =>
      count(models.reduce((total, usage) => total + (pick(usage) ?? 0), 0));
    return {
      inputTokens: sum((usage) => usage.inputTokens),
      outputTokens: sum((usage) => usage.outputTokens),
      cacheReadTokens: sum((usage) => usage.cacheReadInputTokens),
      cacheCreationTokens: sum((usage) => usage.cacheCreationInputTokens),
      costUsd,
    };
  }
  const { usage } = result;
  return {
    inputTokens: count(usage?.input_tokens),
    outputTokens: count(usage?.output_tokens),
    cacheReadTokens: count(usage?.cache_read_input_tokens),
    cacheCreationTokens: count(usage?.cache_creation_input_tokens),
    costUsd,
  };
}

function count(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function nonNegative(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Collects streamed text and passes it on at most once per interval. */
export class DeltaBatcher {
  readonly #intervalMs: number;
  readonly #sink: (text: string) => void;
  #buffer = "";
  #timer: NodeJS.Timeout | null = null;

  constructor(intervalMs: number, sink: (text: string) => void) {
    this.#intervalMs = intervalMs;
    this.#sink = sink;
  }

  push(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.#buffer += text;
    this.#timer ??= setTimeout(() => this.flush(), this.#intervalMs);
  }

  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#buffer.length > 0) {
      const text = this.#buffer;
      this.#buffer = "";
      this.#sink(text);
    }
  }
}

/** Keeps the last `max` characters written to it. */
class TailBuffer {
  readonly #max: number;
  #text = "";

  constructor(max: number) {
    this.#max = max;
  }

  push(data: string): void {
    this.#text = (this.#text + data).slice(-this.#max);
  }

  text(): string {
    return this.#text;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
