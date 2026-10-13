import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@loomcast/ui/components/tooltip";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { describeStudio, devicesQueryOptions, STUDIO_LABELS, summarizeStudio } from "./queries";

/**
 * The topbar pill: online when any studio agent is connected. It links to the
 * devices settings, where pairing happens.
 */
export function StudioStatus() {
  const query = useQuery(devicesQueryOptions());

  if (query.isPending) {
    return <Skeleton aria-hidden="true" className="h-[21px] w-[104px] rounded-full" />;
  }

  const summary = query.isSuccess ? summarizeStudio(query.data) : null;
  const label = summary ? STUDIO_LABELS[summary.state] : "Studio unknown";
  const description = summary
    ? describeStudio(summary)
    : "Couldn't check the studio. The status updates when the connection returns.";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/settings/devices"
          aria-label={`${label}. ${description}`}
          className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <StatusPill kind="device" status={summary?.state === "online" ? "online" : "offline"}>
            <span className="max-sm:hidden">{label}</span>
            <span className="sm:hidden">Studio</span>
          </StatusPill>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}
