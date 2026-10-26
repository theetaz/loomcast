// Manual smoke test of the producer runtime; not part of CI. It runs one real turn and then a
// resumed turn against the subscription this Mac is logged in with, and prints both session ids.
//
//   pnpm --filter @loomcast/studio-agent exec tsx scripts/smoke-producer.ts
//
// It works in a temporary workspace folder, which it deletes afterwards.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobFailure } from "../src/handlers";
import { createLogger } from "../src/logger";
import { resolveAgentPaths } from "../src/paths";
import type { ProducerRunResult } from "../src/producer/runtime";
import { SdkProducerRuntime } from "../src/producer/sdk-runtime";
import { ensureWorkspaceWorkspace } from "../src/producer/workspace";

const TURN_TIMEOUT_MS = 180_000;

const root = mkdtempSync(join(tmpdir(), "loomcast-producer-smoke-"));
const runtime = new SdkProducerRuntime({
  protectedDirs: [resolveAgentPaths().home],
  log: createLogger({ level: "warn" }),
});

async function turn(
  cwd: string,
  label: string,
  prompt: string,
  resumeId?: string,
): Promise<ProducerRunResult> {
  console.log(`\n${label}: ${prompt}${resumeId === undefined ? "" : ` (resume ${resumeId})`}`);
  const signal = AbortSignal.timeout(TURN_TIMEOUT_MS);
  const result = await runtime.run({
    prompt,
    resumeId,
    cwd,
    signal,
    onEvent: (event) => console.log(`  event ${event.kind} ${JSON.stringify(event.data)}`),
    onDelta: (text) => console.log(`  delta ${JSON.stringify(text)}`),
  });
  console.log(`  session ${result.sessionId}`);
  console.log(`  answer  ${JSON.stringify(result.finalText)}`);
  console.log(`  turns ${result.numTurns}, ${result.durationMs} ms`);
  return result;
}

let exitCode = 0;
try {
  const { dir } = await ensureWorkspaceWorkspace(root, randomUUID(), "Producer smoke test");
  console.log(`workspace ${dir}`);
  const first = await turn(dir, "turn 1", "Reply with the word ready");
  const second = await turn(dir, "turn 2", "What did you just say?", first.sessionId);

  const same = first.sessionId === second.sessionId;
  console.log(`\nturn 1 session: ${first.sessionId}`);
  console.log(`turn 2 session: ${second.sessionId}`);
  console.log(same ? "OK: the resumed turn kept the session" : "FAIL: the session id changed");
  exitCode = same ? 0 : 1;
} catch (error) {
  if (error instanceof JobFailure) {
    console.error(`FAIL: ${error.code}: ${error.message}`);
  } else {
    console.error("FAIL:", error);
  }
  exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);
