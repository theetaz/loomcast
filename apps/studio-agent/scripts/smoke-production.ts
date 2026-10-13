// Manual smoke test of the production jobs against the local stack; not part of CI. It runs the
// real handlers in order (script, storyboard, voice, render) for one content item, with the
// producer runtime this Mac is logged in with, the TTS provider and a real render. Every step
// costs time and money, so it only runs when LOOMCAST_SMOKE=1.
//
//   LOOMCAST_SMOKE=1 \
//   LOOMCAST_SMOKE_TOKEN=<an access token with mcp:read and mcp:write> \
//   LOOMCAST_SMOKE_ITEM_ID=<a content item of the local stack> \
//   pnpm --filter @loomcast/studio-agent exec tsx scripts/smoke-production.ts
//
// Optional: LOOMCAST_SMOKE_SERVER (default http://127.0.0.1:8790), LOOMCAST_SMOKE_THROUGH
// (script|storyboard|voice|render, default render), LOOMCAST_SMOKE_VOICE_ID (when the item has no
// format voice), LOOMCAST_SMOKE_WORKSPACE (default a temporary folder, deleted afterwards).
//
// The handlers return their results as they would to the server; this script stores the script
// and the storyboard as new versions with content.submit_for_review, so the next step reads them.
// The token is read from the environment and never printed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContentSubmitForReviewOutputSchema,
  DEFAULT_FORMAT_RULES,
  type FormatSnapshot,
  type JobEventData,
  type JobEventKind,
  type JobPayload,
  type JobType,
} from "@loomcast/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpCredentials, type JobContext, JobFailure } from "../src/handlers";
import { renderHandler } from "../src/jobs/content-render";
import { storyboardHandler } from "../src/jobs/content-storyboard";
import { voiceHandler } from "../src/jobs/content-voice";
import { writeScriptHandler } from "../src/jobs/content-write-script";
import { createLogger } from "../src/logger";
import { resolveAgentPaths } from "../src/paths";
import { SdkProducerRuntime } from "../src/producer/sdk-runtime";
import type { ProducerStepDeps } from "../src/production/context";
import { voiceKeyReader } from "../src/production/deps";
import { httpTransport, mcpPlatformConnector } from "../src/production/platform";
import { studioLoader } from "../src/production/studio";

const STEPS = ["script", "storyboard", "voice", "render"] as const;
type Step = (typeof STEPS)[number];
const STEP_TIMEOUT_MS = 30 * 60_000;

if (process.env.LOOMCAST_SMOKE !== "1") {
  console.error("Set LOOMCAST_SMOKE=1 to run the production smoke test (it renders for real).");
  process.exit(2);
}
const token = process.env.LOOMCAST_SMOKE_TOKEN ?? "";
const itemId = process.env.LOOMCAST_SMOKE_ITEM_ID ?? "";
if (token === "" || itemId === "") {
  console.error("Set LOOMCAST_SMOKE_TOKEN and LOOMCAST_SMOKE_ITEM_ID.");
  process.exit(2);
}
const through = (process.env.LOOMCAST_SMOKE_THROUGH ?? "render") as Step;
if (!STEPS.includes(through)) {
  console.error(`LOOMCAST_SMOKE_THROUGH must be one of ${STEPS.join(", ")}.`);
  process.exit(2);
}
const server = process.env.LOOMCAST_SMOKE_SERVER ?? "http://127.0.0.1:8790";
const credentials = createMcpCredentials(
  new URL("/mcp", server),
  token,
  new Date(Date.now() + 3_600_000).toISOString(),
);
const ownWorkspace = process.env.LOOMCAST_SMOKE_WORKSPACE === undefined;
const workspaceRoot =
  process.env.LOOMCAST_SMOKE_WORKSPACE ?? mkdtempSync(join(tmpdir(), "loomcast-production-smoke-"));
const log = createLogger({ level: "info" });
const paths = resolveAgentPaths();
const studio = studioLoader();
const deps: ProducerStepDeps = {
  workspaceRoot,
  connect: mcpPlatformConnector(),
  studio,
  voiceKey: voiceKeyReader(paths, studio),
  runtime: new SdkProducerRuntime({ protectedDirs: [paths.home], log }),
  log,
};

/** A job context that prints events instead of sending them. */
function context<T extends JobType>(
  type: T,
  payload: JobPayload<T>,
  projectId: string,
): JobContext<T> {
  return {
    job: {
      id: crypto.randomUUID(),
      type,
      projectId,
      attempt: 1,
      payload,
    } as JobContext<T>["job"],
    credentials: { mcp: credentials },
    emit: <K extends JobEventKind>(kind: K, data: JobEventData<K>) =>
      console.log(`  ${type} ${kind} ${JSON.stringify(data)}`),
    stream: () => {},
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    log,
  };
}

/** One MCP client for the reads and submissions the script makes itself. */
async function mcp(): Promise<Client> {
  const client = new Client({ name: "loomcast-production-smoke", version: "0.0.0" });
  await client.connect(httpTransport(credentials));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  }
  return result.structuredContent;
}

let exitCode = 0;
const client = await mcp();
try {
  const current = (await call(client, "content.get", { itemId })) as {
    item: { projectId: string; currentVersionId: string };
    format: FormatSnapshot | null;
  };
  const projectId = current.item.projectId;
  const format: FormatSnapshot = current.format ?? {
    formatVersionId: null,
    rules: structuredClone(DEFAULT_FORMAT_RULES),
  };
  const voiceId = format.rules.voiceId ?? process.env.LOOMCAST_SMOKE_VOICE_ID;
  let versionId = current.item.currentVersionId;
  const base = () => ({ projectId, itemId, versionId, format });
  const submit = async (artifacts: Record<string, unknown>): Promise<void> => {
    const output = ContentSubmitForReviewOutputSchema.parse(
      await call(client, "content.submit_for_review", {
        itemId,
        baseVersionId: versionId,
        ...artifacts,
      }),
    );
    versionId = output.versionId;
    console.log(`  saved version ${output.versionNo} (${output.state})`);
  };

  console.log(`workspace ${workspaceRoot}\nitem ${itemId} from version ${versionId}`);
  const script = await writeScriptHandler(deps)(context("content.write_script", base(), projectId));
  console.log(
    `script: ${script.script.segments.length} segments, ${script.script.estimatedDurationMs} ms`,
  );
  await submit({ script: script.script });

  if (STEPS.indexOf(through) >= 1) {
    const board = await storyboardHandler(deps)(context("content.storyboard", base(), projectId));
    console.log(`storyboard: ${board.storyboard.frames.length} frames`);
    await submit({ storyboard: board.storyboard });
  }
  let voiceAssetId: string | undefined;
  if (STEPS.indexOf(through) >= 2) {
    if (voiceId === undefined) {
      throw new Error("The item's format has no voice; set LOOMCAST_SMOKE_VOICE_ID");
    }
    const voice = await voiceHandler(deps)(
      context("content.voice", { ...base(), voice: { voiceId } }, projectId),
    );
    voiceAssetId = voice.voiceAssetId;
    console.log(`voice: asset ${voice.voiceAssetId}, ${voice.durationMs} ms`);
  }
  if (STEPS.indexOf(through) >= 3 && voiceAssetId !== undefined) {
    const render = await renderHandler(deps)(
      context("content.render", { ...base(), voiceAssetId }, projectId),
    );
    console.log(
      `render: asset ${render.renderAssetId}, poster ${render.posterAssetId}, ${render.width}x${render.height}, ${render.durationMs} ms`,
    );
  }
  console.log(`OK: ran through ${through}`);
} catch (error) {
  if (error instanceof JobFailure) {
    console.error(`FAIL: ${error.code}: ${error.message}`);
  } else {
    console.error("FAIL:", error instanceof Error ? error.message : error);
  }
  exitCode = 1;
} finally {
  await client.close().catch(() => {});
  if (ownWorkspace) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}
process.exit(exitCode);
