import type { Asset } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { AudioLinesIcon, CheckIcon, RefreshCwIcon } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { formatDuration } from "@/features/library/format";
import { errorMessage, isApiError } from "@/lib/api";
import { useAssetUrl, useMediaSource } from "./asset-url";
import { EditConflictBanner, isEditConflict } from "./EditNotices";
import { formatBytes } from "./media-format";
import { itemAssetsQueryOptions, useEditVersion } from "./queries";
import type { ItemTabProps } from "./tab-props";

/**
 * Every voice take of the item, newest first, each with a player. The take the shown version uses
 * is marked; "Use this take" writes a version with another one. Regenerate records a new take.
 */
export function VoiceTab({
  detail,
  version,
  canEdit,
  editBlocked,
  decisions,
  viewingCurrent,
}: ItemTabProps) {
  const takes = useQuery(itemAssetsQueryOptions(detail.item.id, "voice"));
  const edit = useEditVersion(detail.item.id);
  const conflict = edit.isError && isEditConflict(edit.error);

  const choose = (take: Asset) =>
    edit.mutate(
      { baseVersionId: detail.currentVersion.id, voiceAssetId: take.id },
      {
        onSuccess: ({ version: saved }) =>
          toast.success(`Using ${take.filename}`, {
            description: `Saved as v${saved.versionNo}. The video needs rendering again.`,
          }),
        onError: (error) => {
          if (!isEditConflict(error)) {
            toast.error("Couldn't switch the take", { description: errorMessage(error) });
          }
        },
      },
    );

  const regenerate = decisions.can("voice") && viewingCurrent;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-divider border-b px-4 py-2.5">
        <p className="text-small text-muted-foreground">
          {takes.data
            ? `${takes.data.length} ${takes.data.length === 1 ? "take" : "takes"}`
            : "Takes"}
          {!canEdit && editBlocked && viewingCurrent ? (
            <span className="text-text-4"> · {editBlocked}</span>
          ) : null}
        </p>
        {regenerate ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={decisions.busy || decisions.hasActiveJob}
            onClick={() => decisions.start("voice")}
          >
            <RefreshCwIcon aria-hidden="true" />
            Regenerate
          </Button>
        ) : null}
      </div>
      {conflict ? (
        <div className="px-4 pt-3">
          <EditConflictBanner kind="conflict" busy={edit.isPending} onReload={() => edit.reset()} />
        </div>
      ) : null}
      {takes.isPending ? (
        <div aria-hidden="true" className="flex flex-col gap-3 px-4 py-4">
          <Skeleton className="h-16 rounded-md" />
          <Skeleton className="h-16 rounded-md" />
        </div>
      ) : takes.isError ? (
        <ErrorState
          size="compact"
          title="Couldn't load the voice takes"
          error={takes.error}
          onRetry={() => void takes.refetch()}
          retrying={takes.isFetching}
        />
      ) : takes.data.length === 0 ? (
        <EmptyState
          size="compact"
          icon={AudioLinesIcon}
          title="No voice takes yet"
          description="Takes appear here once the studio agent records the script."
        />
      ) : (
        <ul aria-label="Voice takes" className="flex flex-col">
          {takes.data.map((take) => (
            <TakeRow
              key={take.id}
              take={take}
              inUse={take.id === version.voiceAssetId}
              canChoose={canEdit && take.status === "ready"}
              choosing={edit.isPending && edit.variables?.voiceAssetId === take.id}
              disabled={edit.isPending}
              onChoose={() => choose(take)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TakeRow({
  take,
  inUse,
  canChoose,
  choosing,
  disabled,
  onChoose,
}: {
  take: Asset;
  inUse: boolean;
  canChoose: boolean;
  choosing: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <li
      aria-label={take.filename}
      className={cn(
        "flex flex-col gap-2 border-divider border-t px-4 py-3 first:border-t-0",
        inUse && "bg-accent-soft/50 dark:bg-accent-soft/25",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate font-medium text-body">{take.filename}</span>
        {inUse ? (
          <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-primary">
            <CheckIcon aria-hidden="true" className="size-3" />
            In use
          </span>
        ) : null}
        <span className="text-small text-muted-foreground">
          {take.durationMs !== null ? `${formatDuration(take.durationMs)} · ` : ""}
          {formatBytes(take.bytes)} · <RelativeTime value={take.createdAt} format="relative" />
        </span>
        {!inUse && canChoose ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={disabled}
            onClick={onChoose}
          >
            {choosing ? "Switching…" : "Use this take"}
          </Button>
        ) : null}
      </div>
      {take.status === "ready" ? (
        <TakePlayer assetId={take.id} label={take.filename} />
      ) : (
        <p className="text-small text-text-4">
          {take.status === "pending" ? "Still uploading." : "The upload failed its checks."}
        </p>
      )}
    </li>
  );
}

/** An audio player on a presigned URL that is replaced before it expires. Never autoplays. */
function TakePlayer({ assetId, label }: { assetId: string; label: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const url = useAssetUrl(assetId);
  useMediaSource(ref, url.data?.url);
  if (url.isError && !isApiError(url.error, 409)) {
    return (
      <p className="text-small text-destructive">
        {errorMessage(url.error, "Couldn't load this take.")}{" "}
        <button type="button" className="underline" onClick={() => void url.refetch()}>
          Try again
        </button>
      </p>
    );
  }
  return (
    // biome-ignore lint/a11y/useMediaCaption: voice takes are the narration itself; the script tab has its words.
    <audio
      ref={ref}
      controls
      preload="none"
      aria-label={`Play ${label}`}
      className="h-9 w-full max-w-md"
    />
  );
}
