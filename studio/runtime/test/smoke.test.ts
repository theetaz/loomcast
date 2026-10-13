import { describe, expect, it } from "vitest";
import { SMOKE_DURATION_MS, smokeRender } from "../scripts/smoke-render.ts";
import { checkRenderTools } from "../src/preflight.ts";

// One short real render (five seconds, synthetic content, temporary directory, deleted). It runs
// only where ffmpeg, ffprobe and an already-installed render browser exist, and never in CI or
// when LOOMCAST_SKIP_SMOKE_RENDER=1, so the suite stays offline and nothing is downloaded.
const tools = await checkRenderTools();
const enabled = tools.ready && !process.env.CI && process.env.LOOMCAST_SKIP_SMOKE_RENDER !== "1";

describe.runIf(enabled)("smoke render", () => {
  it("renders a valid 1080x1920 MP4 of the voice's length", async () => {
    const result = await smokeRender();
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
    expect(Math.abs(result.durationMs - SMOKE_DURATION_MS)).toBeLessThanOrEqual(500);
    expect(result.sizeBytes).toBeGreaterThan(10_000);
    expect(result.kept).toBeUndefined();
  }, 240_000);
});
