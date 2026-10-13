import { type ProducerChatResult, parseJobPayload } from "@loomcast/contracts";
import { type Handler, type JobContext, JobFailure } from "../handlers";
import { chatBrief } from "../producer/prompts/chat";
import {
  PRODUCER_ERROR_CODES,
  ProducerError,
  type ProducerEvent,
  type ProducerRunResult,
  type ProducerRuntime,
} from "../producer/runtime";
import { SdkProducerRuntime } from "../producer/sdk-runtime";
import { ProducerSessions } from "../producer/sessions";
import { ensureProjectWorkspace } from "../producer/workspace";
import type { HandlerDeps } from "./index";

/** The local session cache, as the handler uses it. */
export interface SessionCache {
  get(conversationId: string): string | undefined;
  set(conversationId: string, sessionId: string): void;
}

export interface ProducerChatOptions {
  readonly runtime: ProducerRuntime;
  readonly sessions: SessionCache;
  /** Producer sessions work in `<workspaceRoot>/projects/<projectId>`. */
  readonly workspaceRoot: string;
}

/** The `producer.chat` handler of a running agent: the producer runtime with the guarded tools. */
export function createProducerChatHandler(deps: HandlerDeps): Handler<"producer.chat"> {
  return producerChatHandler({
    runtime: new SdkProducerRuntime({ protectedDirs: [deps.paths.home], log: deps.log }),
    sessions: new ProducerSessions(deps.paths),
    workspaceRoot: deps.config.workspaceRoot,
  });
}

/**
 * `producer.chat`: runs one chat turn in the conversation's producer session.
 *
 * The session to resume is the payload's `producerSessionId`, or the locally cached one when the
 * server sends none. If that session is not on this Mac, the turn starts a new session and says so
 * in a `log` event. The result's `sdkSessionId` is what the server sends back on the next turn.
 */
export function producerChatHandler(options: ProducerChatOptions): Handler<"producer.chat"> {
  return async (ctx): Promise<ProducerChatResult> => {
    const parsed = parseJobPayload("producer.chat", ctx.job.payload);
    if (!parsed.success) {
      throw new JobFailure("invalid_payload", "The producer.chat payload is invalid");
    }
    const payload = parsed.data;
    if (payload.projectId !== ctx.job.projectId) {
      throw new JobFailure("invalid_payload", "The payload's project does not match the job's");
    }

    ctx.emit("status", { state: "starting" });
    const workspace = await ensureProjectWorkspace(options.workspaceRoot, payload.projectId);
    const resumeId = payload.producerSessionId ?? options.sessions.get(payload.conversationId);
    const mcp = ctx.credentials.mcp;
    if (mcp === undefined) {
      ctx.log.info("no job token for this turn; the session runs without the knowledge base");
    }

    const run = (resume: string | undefined): Promise<ProducerRunResult> =>
      options.runtime.run({
        prompt: payload.text,
        resumeId: resume,
        cwd: workspace.dir,
        signal: ctx.signal,
        jobType: "producer.chat",
        mcp,
        brief: chatBrief(payload.projectId),
        onEvent: (event) => emitProducerEvent(ctx, event),
        onDelta: (text) => ctx.stream(text),
      });

    let result: ProducerRunResult;
    try {
      result = await run(resumeId);
    } catch (error) {
      if (
        resumeId === undefined ||
        ctx.signal.aborted ||
        !(error instanceof ProducerError) ||
        error.code !== PRODUCER_ERROR_CODES.sessionNotFound
      ) {
        throw error;
      }
      ctx.log.warn("producer session not found on this Mac; starting a new one");
      ctx.emit("log", {
        level: "warn",
        message: "The earlier producer session was not found on this Mac, so a new one started",
      });
      result = await run(undefined);
    }

    try {
      options.sessions.set(payload.conversationId, result.sessionId);
    } catch (error) {
      ctx.log.warn("could not cache the producer session", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    ctx.log.info("producer turn finished", {
      numTurns: result.numTurns,
      resumed: resumeId !== undefined,
    });
    return {
      sdkSessionId: result.sessionId,
      finalText: result.finalText,
      numTurns: result.numTurns,
      durationMs: result.durationMs,
    };
  };
}

function emitProducerEvent(ctx: JobContext<"producer.chat">, event: ProducerEvent): void {
  switch (event.kind) {
    case "session":
      ctx.emit("session", event.data);
      return;
    case "status":
      ctx.emit("status", event.data);
      return;
    case "tool.activity":
      ctx.emit("tool.activity", event.data);
      return;
    case "assistant.message":
      ctx.emit("assistant.message", event.data);
      return;
    case "usage":
      ctx.emit("usage", event.data);
      return;
  }
}
