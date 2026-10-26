import { SidebarMenuBadge } from "@loomcast/ui/components/sidebar";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { approvalsQueryOptions } from "@/features/approvals/queries";
import { reviewQueueQueryOptions } from "@/features/review-queue/queries";
import type { NavBadgeProps } from "./registry";

function Count({ count, more = false, label }: { count: number; more?: boolean; label: string }) {
  if (!count) return null;
  return (
    <SidebarMenuBadge className="top-1">
      <span className="sr-only">, </span>
      {count}
      {more ? "+" : ""}
      <span className="sr-only"> {label}</span>
    </SidebarMenuBadge>
  );
}

/** Videos of the workspace waiting in review, next to Review. Shares the queue's cache. */
export function ReviewCount({ workspaceId }: NavBadgeProps) {
  const { data, hasNextPage } = useInfiniteQuery(reviewQueueQueryOptions(workspaceId));
  const count = data?.pages.reduce((total, page) => total + page.items.length, 0) ?? 0;
  return <Count count={count} more={hasNextPage} label="waiting for review" />;
}

/** Videos of the workspace waiting for approval, next to Approvals. Shares the inbox's cache. */
export function ApprovalsCount({ workspaceId }: NavBadgeProps) {
  const { data } = useQuery(approvalsQueryOptions(workspaceId));
  return <Count count={data?.items.length ?? 0} label="waiting for approval" />;
}
