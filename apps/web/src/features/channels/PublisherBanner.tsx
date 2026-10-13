import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { FlaskConicalIcon, PauseCircleIcon } from "lucide-react";
import { publisherStatusQueryOptions } from "./queries";

/**
 * The server's publishing switches, from `publisher.status`: a banner while the server only
 * dry-runs or while publishing is paused. Live and running says nothing.
 */
export function PublisherBanner({ className }: { className?: string }) {
  const { data } = useQuery(publisherStatusQueryOptions());
  if (!data) return null;
  const paused = !data.enabled;
  const dryRun = data.mode === "dry-run";
  if (!paused && !dryRun) return null;

  const Icon = paused ? PauseCircleIcon : FlaskConicalIcon;
  return (
    <div
      role="status"
      data-publisher={paused ? "paused" : "dry-run"}
      className={cn(
        "flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-control",
        paused ? "bg-status-amber/11 text-foreground" : "bg-status-violet/11 text-foreground",
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          paused ? "text-status-amber" : "text-status-violet",
        )}
      />
      <p className="min-w-0 text-pretty">
        {paused ? (
          <>
            <span className="font-medium">Publishing is paused.</span> Posts that come due wait
            until it is switched back on
            {dryRun ? ", and the server only dry-runs." : "."}
          </>
        ) : (
          <>
            <span className="font-medium">Dry-run mode.</span> Every channel records the exact
            request it would send and nothing is published. Channels can go live once the server
            publishes live.
          </>
        )}
      </p>
    </div>
  );
}
