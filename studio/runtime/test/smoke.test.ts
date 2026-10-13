import { describe, expect, it } from "vitest";
import { SMOKE_DURATION_MS, smokeRender } from "../scripts/smoke-render.ts";
import { checkRenderTools } from "../src/preflight.ts";

// One short real render (five seconds, synthetic content, temporary directory, deleted). It is
// opt-in: it runs only with LOOMCAST_SMOKE_RENDER=1 (`pnpm --filter @loomcast/studio test:smoke`)
// and only where ffmpeg, ffprobe and an already-installed render browser exist, so the default
// suite stays fast and offline and nothing is ever downloaded.
const requested = process.env.LOOMCAST_SMOKE_RENDER === "1";
const tools = requested ? await checkRenderTools() : undefined;
const skipReason = !requested
  ? "set LOOMCAST_SMOKE_RENDER=1 to run the real smoke render"
  : !tools?.ready
    ? `render tools are missing: ${JSON.stringify(tools)}`
    : undefined;

describe.skipIf(skipReason !== undefined)(
  `smoke render${skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    it("renders a valid 1080x1920 MP4 of the voice's length", async () => {
      const result = await smokeRender();
      expect(result.width).toBe(1080);
      expect(result.height).toBe(1920);
      expect(Math.abs(result.durationMs - SMOKE_DURATION_MS)).toBeLessThanOrEqual(500);
      expect(result.sizeBytes).toBeGreaterThan(10_000);
      expect(result.kept).toBeUndefined();
    }, 240_000);
  },
);
