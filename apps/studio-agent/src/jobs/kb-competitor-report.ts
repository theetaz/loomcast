import {
  COMPETITOR_REPORT_LIMITS,
  type CompetitorInsights,
  CompetitorInsightsSchema,
  type KbCompetitorReportResult,
  parseJobPayload,
} from "@loomcast/contracts";
import { type Handler, JobFailure } from "../handlers";
import {
  REPORT_BRIEF,
  reportPrompt,
  reportRepairPrompt,
} from "../producer/prompts/competitor-report";
import type { ProducerRunResult, ProducerRuntime } from "../producer/runtime";
import { SdkProducerRuntime } from "../producer/sdk-runtime";
import { ensureProjectWorkspace } from "../producer/workspace";
import type { HandlerDeps } from "./index";
import { describeIssues, extractJsonBlock, SessionEvents, truncate } from "./kb-analyze-reference";

export interface CompetitorReportOptions {
  readonly runtime: ProducerRuntime;
  /** The session runs in `<workspaceRoot>/projects/<projectId>`. */
  readonly workspaceRoot: string;
}

/** The `kb.competitor_report` handler of a running agent. */
export function createKbCompetitorReportHandler(
  deps: HandlerDeps,
): Handler<"kb.competitor_report"> {
  return competitorReportHandler({
    runtime: new SdkProducerRuntime({ protectedDirs: [deps.paths.home], log: deps.log }),
    workspaceRoot: deps.config.workspaceRoot,
  });
}

/**
 * `kb.competitor_report`: writes one report on a competitor from the analyses of its top videos,
 * in a new, read-only producer session.
 *
 * - The captions, analyses and summaries come from the competitor and are sent inside an
 *   untrusted-data block; the numbers are sent as trusted facts. The video links are left out.
 * - The first fenced JSON block of the reply is validated against `CompetitorInsights`; the rest
 *   of the reply is the markdown report. When it does not validate, one repair turn in the same
 *   session gets the problems; a second failure fails the job as `report_invalid`.
 */
export function competitorReportHandler(
  options: CompetitorReportOptions,
): Handler<"kb.competitor_report"> {
  return async (ctx): Promise<KbCompetitorReportResult> => {
    const parsed = parseJobPayload("kb.competitor_report", ctx.job.payload);
    if (!parsed.success) {
      throw new JobFailure("invalid_payload", "The kb.competitor_report payload is invalid");
    }
    const payload = parsed.data;
    if (payload.projectId !== ctx.job.projectId) {
      throw new JobFailure("invalid_payload", "The payload's project does not match the job's");
    }

    ctx.emit("status", { state: "starting" });
    const workspace = await ensureProjectWorkspace(options.workspaceRoot, payload.projectId);
    const events = new SessionEvents(ctx);
    const run = (prompt: string, resumeId?: string): Promise<ProducerRunResult> =>
      options.runtime.run({
        prompt,
        resumeId,
        cwd: workspace.dir,
        signal: ctx.signal,
        jobType: "kb.competitor_report",
        mcp: ctx.credentials.mcp,
        brief: REPORT_BRIEF,
        onEvent: (event) => events.emit(event),
        // The reply is JSON for the server, not text for a conversation.
        onDelta: () => {},
      });

    const first = await run(reportPrompt(payload));
    let reply = readReportReply(first.finalText);
    let turns = first.numTurns;
    if (!reply.ok) {
      ctx.log.warn("report reply did not validate; asking for a repair", {
        problems: reply.problems.length,
      });
      ctx.emit("status", {
        state: "repairing",
        message: truncate(`The report did not validate: ${reply.problems.join("; ")}`, 1_000),
      });
      const repaired = await run(reportRepairPrompt(reply.problems), first.sessionId);
      turns += repaired.numTurns;
      reply = readReportReply(repaired.finalText);
      if (!reply.ok) {
        throw new JobFailure(
          "report_invalid",
          truncate(
            `The producer session did not return a valid report: ${reply.problems.join("; ")}`,
            2_000,
          ),
          false,
        );
      }
    }
    ctx.log.info("competitor report finished", {
      numTurns: turns,
      videos: payload.videos.length,
    });
    return { insights: reply.insights, reportMd: reply.reportMd };
  };
}

export type ReportReply =
  | { readonly ok: true; readonly insights: CompetitorInsights; readonly reportMd: string }
  | { readonly ok: false; readonly problems: string[] };

/** Validates a reply: its first JSON block against `CompetitorInsights`, plus the report. */
export function readReportReply(text: string): ReportReply {
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
  const insights = CompetitorInsightsSchema.safeParse(value);
  const problems = insights.success ? [] : describeIssues(insights.error.issues);
  const reportMd = block.rest.trim();
  if (reportMd.length === 0) {
    problems.push("The markdown report after the JSON block is missing.");
  }
  if (!insights.success || problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    insights: insights.data,
    reportMd: truncate(reportMd, COMPETITOR_REPORT_LIMITS.reportMd),
  };
}
