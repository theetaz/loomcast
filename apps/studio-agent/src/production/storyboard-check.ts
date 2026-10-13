import type { Storyboard } from "@loomcast/contracts";
import type { CardRegistry } from "@loomcast/studio/runtime";
import type { StudioRuntime } from "./studio";

/**
 * The problems that keep a storyboard from rendering: a style other than the format's, and every
 * error the studio runtime finds against its card registry (cards, slots, timing, voice length).
 * Warnings are left out. Each problem names its path, code and message for a repair turn.
 */
export function storyboardProblems(
  storyboard: Storyboard,
  context: {
    readonly studio: StudioRuntime;
    readonly registry: CardRegistry;
    readonly styleId: string;
    readonly voiceDurationMs?: number;
  },
): string[] {
  const problems: string[] = [];
  if (storyboard.styleId !== context.styleId) {
    problems.push(
      `styleId: use the format's style "${context.styleId}", not "${storyboard.styleId}"`,
    );
  }
  const issues = context.studio.validateStoryboard(storyboard, context.registry, {
    ...(context.voiceDurationMs === undefined ? {} : { voiceDurationMs: context.voiceDurationMs }),
  });
  for (const issue of issues) {
    if (issue.severity === "error") {
      problems.push(
        `${issue.path.map(String).join(".") || "(root)"}: ${issue.code}: ${issue.message}`,
      );
    }
  }
  return problems.slice(0, 30);
}
