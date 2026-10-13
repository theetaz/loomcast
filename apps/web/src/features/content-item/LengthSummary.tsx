import type { LengthSec, Script } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";
import { fitTarget, formatSeconds, scriptDuration, scriptWords } from "./timing";

/** Word count and length, measured from the voice or estimated, against the format's target. */
export function LengthSummary({
  script,
  speed,
  target,
}: {
  script: Pick<Script, "segments">;
  speed: number;
  target: LengthSec | null;
}) {
  const words = scriptWords(script);
  const duration = scriptDuration(script, speed);
  const fit = target ? fitTarget(duration.ms, target) : null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-muted-foreground">
      <span>
        <span className="font-medium text-foreground tabular-nums">{words}</span> words
      </span>
      <span aria-hidden="true">·</span>
      <span>
        {duration.measured ? "" : "about "}
        <span className="font-medium text-foreground tabular-nums">
          {formatSeconds(duration.ms)}
        </span>
        {duration.measured ? " spoken" : ""}
      </span>
      {target && fit ? (
        <>
          <span aria-hidden="true">·</span>
          <span
            className={cn(
              fit.fit === "within" ? "text-status-green" : "text-status-amber",
              "font-medium",
            )}
          >
            {fit.fit === "within"
              ? `On target (${target.min}–${target.max} s)`
              : fit.fit === "over"
                ? `${formatSeconds(fit.byMs)} over the ${target.min}–${target.max} s target`
                : `${formatSeconds(fit.byMs)} under the ${target.min}–${target.max} s target`}
          </span>
        </>
      ) : null}
    </p>
  );
}
