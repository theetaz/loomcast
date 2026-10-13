import type { JobContext } from "../handlers";
import { JobFailure } from "../handlers";
import type { ProducerEvent, ProducerRunResult, ProducerRuntime } from "../producer/runtime";
import { type ProducerStepType, stepRepairPrompt } from "./prompts";
import type { JsonReply } from "./reply";
import { truncate } from "./reply";
import type { SkillPackEntry } from "./skills";

/** Repair turns after the first reply, at most. */
export const MAX_REPAIR_TURNS = 2;

export interface ProducerStepInput<T> {
  readonly ctx: JobContext<ProducerStepType>;
  readonly runtime: ProducerRuntime;
  /** The project workspace; a new session starts there for every job. */
  readonly cwd: string;
  readonly brief: string;
  readonly skills: readonly SkillPackEntry[];
  readonly prompt: string;
  /** Validates a reply; problems go back to the session in a repair turn. */
  readonly read: (text: string) => JsonReply<T> | Promise<JsonReply<T>>;
  /** The job error code when the last repair still does not validate. */
  readonly invalidCode: string;
}

export interface ProducerStepResult<T> {
  readonly value: T;
  /** The reply's text outside the JSON block. */
  readonly rest: string;
  readonly sessionId: string;
  readonly numTurns: number;
}

/**
 * Runs a production step in a new producer session: the first turn, then up to two repair turns
 * in the same session while the reply does not validate. Durable events: the session id once,
 * status, tool activity and usage. The reply itself is the result, never a conversation message.
 */
export async function runProducerStep<T>(
  input: ProducerStepInput<T>,
): Promise<ProducerStepResult<T>> {
  const { ctx } = input;
  const events = new StepEvents(ctx);
  const run = (prompt: string, resumeId?: string): Promise<ProducerRunResult> =>
    input.runtime.run({
      prompt,
      resumeId,
      cwd: input.cwd,
      signal: ctx.signal,
      jobType: ctx.job.type,
      mcp: ctx.credentials.mcp,
      brief: input.brief,
      skills: input.skills,
      onEvent: (event) => events.emit(event),
      onDelta: () => {},
    });

  let result = await run(input.prompt);
  let turns = result.numTurns;
  let reply = await input.read(result.finalText);
  for (let repair = 1; !reply.ok; repair += 1) {
    if (repair > MAX_REPAIR_TURNS) {
      throw new JobFailure(
        input.invalidCode,
        truncate(
          `The producer session did not return a valid result: ${reply.problems.join("; ")}`,
          2_000,
        ),
        false,
      );
    }
    ctx.log.warn("producer reply did not validate; asking for a repair", {
      repair,
      problems: reply.problems.length,
    });
    ctx.emit("status", {
      state: "repairing",
      message: truncate(`Repair ${repair}: ${reply.problems.join("; ")}`, 1_000),
    });
    result = await run(stepRepairPrompt(reply.problems), result.sessionId);
    turns += result.numTurns;
    reply = await input.read(result.finalText);
  }
  return { value: reply.value, rest: reply.rest, sessionId: result.sessionId, numTurns: turns };
}

/** Records a step's durable events; the session id is reported once across all turns. */
class StepEvents {
  readonly #ctx: JobContext<ProducerStepType>;
  #sessionId: string | undefined;

  constructor(ctx: JobContext<ProducerStepType>) {
    this.#ctx = ctx;
  }

  emit(event: ProducerEvent): void {
    switch (event.kind) {
      case "session":
        if (this.#sessionId !== event.data.sessionId) {
          this.#sessionId = event.data.sessionId;
          this.#ctx.emit("session", event.data);
        }
        return;
      case "status":
        this.#ctx.emit("status", event.data);
        return;
      case "tool.activity":
        this.#ctx.emit("tool.activity", event.data);
        return;
      case "usage":
        this.#ctx.emit("usage", event.data);
        return;
      case "assistant.message":
        // The reply is the result; production steps record no conversation messages.
        return;
    }
  }
}
