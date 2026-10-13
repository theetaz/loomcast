import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type KbAnalyzeReferenceResult,
  MAX_ANALYSIS_SUMMARY_LENGTH,
  parseJobPayload,
  type ReferenceAnalysis,
  ReferenceAnalysisSchema,
} from "@loomcast/contracts";
import type { z } from "zod";
import { type Handler, type JobContext, JobFailure } from "../handlers";
import {
  ANALYSIS_BRIEF,
  analysisPrompt,
  repairPrompt,
} from "../producer/prompts/analyze-reference";
import type { ProducerEvent, ProducerRunResult, ProducerRuntime } from "../producer/runtime";
import { SdkProducerRuntime } from "../producer/sdk-runtime";
import { ensureProjectWorkspace } from "../producer/workspace";
import type { HandlerDeps } from "./index";

export interface AnalyzeReferenceOptions {
  readonly runtime: ProducerRuntime;
  /** Transcripts are written below `<workspaceRoot>/projects/<projectId>/references/`. */
  readonly workspaceRoot: string;
}

/** The `kb.analyze_reference` handler of a running agent. */
export function createKbAnalyzeReferenceHandler(
  deps: HandlerDeps,
): Handler<"kb.analyze_reference"> {
  return analyzeReferenceHandler({
    runtime: new SdkProducerRuntime({ protectedDirs: [deps.paths.home], log: deps.log }),
    workspaceRoot: deps.config.workspaceRoot,
  });
}

/**
 * `kb.analyze_reference`: analyses a saved reference from its transcript in a new, read-only
 * producer session.
 *
 * - A payload without a transcript (uploaded media only) fails as `transcript_required` before any
 *   session starts; transcribing media is not supported yet.
 * - The transcript is written to `<workspace>/references/<entryId>/transcript.txt` and sent inside
 *   an untrusted-data block. The reference URL is never fetched and never shown to the session.
 * - The first fenced JSON block of the reply is validated against `ReferenceAnalysis`. When it
 *   does not validate, one repair turn in the same session gets the problems; a second failure
 *   fails the job.
 */
export function analyzeReferenceHandler(
  options: AnalyzeReferenceOptions,
): Handler<"kb.analyze_reference"> {
  return async (ctx): Promise<KbAnalyzeReferenceResult> => {
    const parsed = parseJobPayload("kb.analyze_reference", ctx.job.payload);
    if (!parsed.success) {
      throw new JobFailure("invalid_payload", "The kb.analyze_reference payload is invalid");
    }
    const payload = parsed.data;
    if (payload.projectId !== ctx.job.projectId) {
      throw new JobFailure("invalid_payload", "The payload's project does not match the job's");
    }
    const { transcript } = payload;
    if (transcript === undefined) {
      // Analysing uploaded media needs transcription, which this agent cannot do yet.
      throw new JobFailure(
        "transcript_required",
        "This studio agent can only analyse a reference from its transcript; add a transcript",
        false,
      );
    }

    ctx.emit("status", { state: "starting" });
    const workspace = await ensureProjectWorkspace(options.workspaceRoot, payload.projectId);
    const referenceDir = join(workspace.dir, "references", payload.entryId);
    await mkdir(referenceDir, { recursive: true });
    const transcriptPath = join(referenceDir, "transcript.txt");
    await writeFile(transcriptPath, transcript, "utf8");

    const events = new SessionEvents(ctx);
    const run = (prompt: string, resumeId?: string): Promise<ProducerRunResult> =>
      options.runtime.run({
        prompt,
        resumeId,
        cwd: workspace.dir,
        signal: ctx.signal,
        jobType: "kb.analyze_reference",
        mcp: ctx.credentials.mcp,
        brief: ANALYSIS_BRIEF,
        onEvent: (event) => events.emit(event),
        // The reply is JSON for the server, not text for a conversation.
        onDelta: () => {},
      });

    const first = await run(analysisPrompt({ payload, transcript, transcriptPath }));
    let reply = readAnalysisReply(first.finalText);
    let turns = first.numTurns;
    if (!reply.ok) {
      ctx.log.warn("analysis reply did not validate; asking for a repair", {
        problems: reply.problems.length,
      });
      ctx.emit("status", {
        state: "repairing",
        message: truncate(`The analysis did not validate: ${reply.problems.join("; ")}`, 1_000),
      });
      const repaired = await run(repairPrompt(reply.problems), first.sessionId);
      turns += repaired.numTurns;
      reply = readAnalysisReply(repaired.finalText);
      if (!reply.ok) {
        throw new JobFailure(
          "analysis_invalid",
          truncate(
            `The producer session did not return a valid analysis: ${reply.problems.join("; ")}`,
            2_000,
          ),
          false,
        );
      }
    }
    ctx.log.info("reference analysis finished", { numTurns: turns });
    return { analysis: reply.analysis, summaryMd: reply.summaryMd };
  };
}

/** Records a session's durable events; the session id is reported once across both turns. */
class SessionEvents {
  readonly #ctx: JobContext<"kb.analyze_reference">;
  #sessionId: string | undefined;

  constructor(ctx: JobContext<"kb.analyze_reference">) {
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
        // The reply is the result; it is not a conversation message.
        return;
    }
  }
}

export type AnalysisReply =
  | { readonly ok: true; readonly analysis: ReferenceAnalysis; readonly summaryMd: string }
  | { readonly ok: false; readonly problems: string[] };

const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g;

/** The first fenced code block marked `json` (or unmarked), and the reply without it. */
export function extractJsonBlock(text: string): { json: string; rest: string } | null {
  for (const match of text.matchAll(FENCE)) {
    const language = match[1]?.toLowerCase() ?? "";
    if (language === "json" || language === "") {
      const start = match.index ?? 0;
      return {
        json: match[2] ?? "",
        rest: `${text.slice(0, start)}${text.slice(start + match[0].length)}`,
      };
    }
  }
  return null;
}

/** Validates a reply: its first JSON block against `ReferenceAnalysis`, plus the summary. */
export function readAnalysisReply(text: string): AnalysisReply {
  const block = extractJsonBlock(text);
  if (block === null) {
    return { ok: false, problems: ["The reply has no fenced ```json code block."] };
  }
  let value: unknown;
  try {
    value = JSON.parse(block.json);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`The JSON block is not valid JSON: ${truncate(reason, 300)}`] };
  }
  const analysis = ReferenceAnalysisSchema.safeParse(value);
  if (!analysis.success) {
    return { ok: false, problems: describeIssues(analysis.error.issues) };
  }
  return { ok: true, analysis: analysis.data, summaryMd: summaryOf(block.rest, analysis.data) };
}

/** The model's summary, or one built from the analysis when the reply has none. */
function summaryOf(rest: string, analysis: ReferenceAnalysis): string {
  const written = rest.trim();
  if (written.length > 0) {
    return truncate(written, MAX_ANALYSIS_SUMMARY_LENGTH);
  }
  const lines = [
    `**Hook (${analysis.hook.type}):** ${analysis.hook.text}`,
    "",
    ...analysis.takeaways.map((takeaway) => `- ${takeaway}`),
  ];
  return truncate(lines.join("\n"), MAX_ANALYSIS_SUMMARY_LENGTH);
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  const described = issues
    .slice(0, 20)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${truncate(issue.message, 200)}`);
  if (issues.length > described.length) {
    described.push(`…and ${issues.length - described.length} more problems`);
  }
  return described;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
