import type { Script } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { XIcon } from "lucide-react";
import { useMemo } from "react";
import { diffStats, scriptText, wordDiff } from "./diff";

/** A word diff between two scripts: removed words struck through, added words highlighted. */
export function ScriptDiff({
  before,
  after,
  beforeLabel,
  afterLabel,
  onClose,
}: {
  before: Script;
  after: Script;
  beforeLabel: string;
  afterLabel: string;
  onClose: () => void;
}) {
  const parts = useMemo(() => wordDiff(scriptText(before), scriptText(after)), [before, after]);
  const stats = diffStats(parts);
  const unchanged = stats.added === 0 && stats.removed === 0;

  return (
    <section aria-label={`Changes from ${beforeLabel} to ${afterLabel}`} className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-divider border-b px-4 py-2.5">
        <p className="font-medium text-[13px]">
          {beforeLabel} → {afterLabel}
        </p>
        <p className="text-small text-muted-foreground">
          {unchanged ? (
            "No changes to the words"
          ) : (
            <>
              <span className="text-status-green">{stats.added} added</span>
              {", "}
              <span className="text-status-red">{stats.removed} removed</span>
            </>
          )}
        </p>
        <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
          <XIcon aria-hidden="true" />
          Close compare
        </Button>
      </div>
      <p
        data-testid="script-diff"
        className="whitespace-pre-wrap break-words px-4 py-4 text-body leading-relaxed"
      >
        {parts.map((part, index) => {
          const key = `${index}:${part.kind}`;
          if (part.kind === "added") {
            return (
              <ins
                key={key}
                className="rounded-[3px] bg-status-green/15 text-foreground no-underline [box-decoration-break:clone]"
              >
                {part.text}
              </ins>
            );
          }
          if (part.kind === "removed") {
            return (
              <del
                key={key}
                className="mr-1 rounded-[3px] bg-status-red/12 text-muted-foreground decoration-status-red/60 [box-decoration-break:clone]"
              >
                {part.text}
              </del>
            );
          }
          return <span key={key}>{part.text}</span>;
        })}
      </p>
    </section>
  );
}
