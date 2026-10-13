import { Skeleton } from "@loomcast/ui/components/skeleton";

/** Placeholder rows while a conversation loads. */
export function MessagesSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-5 md:px-6"
    >
      <Skeleton className="ml-auto h-9 w-2/5 rounded-lg" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-3/5" />
      </div>
      <Skeleton className="ml-auto h-9 w-1/3 rounded-lg" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-10/12" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}
