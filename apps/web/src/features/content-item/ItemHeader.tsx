import { CONTENT_TITLE_MAX_LENGTH, type ContentItem, type Series } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { cn } from "@loomcast/ui/lib/cn";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  MessageSquareWarningIcon,
  PencilIcon,
  ThumbsDownIcon,
  WandSparklesIcon,
} from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { RelativeTime } from "@/components/RelativeTime";
import { errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import type { ItemDecisions } from "./decisions";
import { useRenameItem } from "./queries";

/** States after which a missed target no longer matters. */
const DONE_STATES = new Set(["published", "archived"]);

/**
 * The item's title (renamed in place), its state, version, series and target date, and the
 * actions `allowedActions` offers.
 */
export function ItemHeader({
  item,
  series,
  decisions,
  onRequestChanges,
}: {
  item: ContentItem;
  series: Series | null;
  decisions: ItemDecisions;
  onRequestChanges: () => void;
}) {
  const now = useNow();
  const overdue =
    item.targetAt !== null && Date.parse(item.targetAt) < now && !DONE_STATES.has(item.state);

  return (
    <header className="flex flex-col gap-3 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <EditableTitle item={item} />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted-foreground">
          <StatusPill kind="pipeline" status={item.state} />
          <span className="font-mono text-mono">v{item.versionNo}</span>
          {series ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate">{series.name}</span>
            </>
          ) : null}
          {item.targetAt ? (
            <>
              <span aria-hidden="true">·</span>
              <span className={cn(overdue && "text-status-red")}>
                {overdue ? "Was due" : "Due"}{" "}
                <time dateTime={item.targetAt}>{formatDateTime(item.targetAt)}</time>
              </span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span>
            Updated <RelativeTime value={item.updatedAt} format="relative" />
          </span>
        </div>
        {item.pitch ? <p className="max-w-prose text-body text-text-2">{item.pitch}</p> : null}
      </div>
      <HeaderActions decisions={decisions} onRequestChanges={onRequestChanges} />
    </header>
  );
}

function HeaderActions({
  decisions,
  onRequestChanges,
}: {
  decisions: ItemDecisions;
  onRequestChanges: () => void;
}) {
  const { can, busy, hasActiveJob } = decisions;
  const inReview = can("approve") || can("request_changes") || can("reject");
  if (!inReview && !can("produce") && !can("archive") && !can("restore")) {
    return null;
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      {can("produce") ? (
        <Button
          type="button"
          disabled={busy || hasActiveJob}
          onClick={() => decisions.start("produce")}
        >
          <WandSparklesIcon aria-hidden="true" />
          Produce
        </Button>
      ) : null}
      {can("approve") ? (
        <Button type="button" disabled={busy || hasActiveJob} onClick={decisions.approve}>
          <CheckIcon aria-hidden="true" />
          Approve
        </Button>
      ) : null}
      {can("request_changes") ? (
        <Button type="button" variant="outline" disabled={busy} onClick={onRequestChanges}>
          <MessageSquareWarningIcon aria-hidden="true" />
          Request changes
        </Button>
      ) : null}
      {can("reject") ? (
        <Button
          type="button"
          variant="ghost"
          disabled={busy || hasActiveJob}
          onClick={decisions.confirmReject}
        >
          <ThumbsDownIcon aria-hidden="true" />
          Reject
        </Button>
      ) : null}
      {can("restore") ? (
        <Button type="button" variant="outline" disabled={busy} onClick={decisions.restore}>
          <ArchiveRestoreIcon aria-hidden="true" />
          Restore
        </Button>
      ) : null}
      {can("archive") ? (
        <Button
          type="button"
          variant="ghost"
          disabled={busy || hasActiveJob}
          onClick={decisions.confirmArchive}
        >
          <ArchiveIcon aria-hidden="true" />
          Archive
        </Button>
      ) : null}
    </div>
  );
}

/** The title as a heading, or a field while it is being renamed. Enter saves, Escape cancels. */
function EditableTitle({ item }: { item: ContentItem }) {
  const rename = useRenameItem(item.id);
  const [draft, setDraft] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();
  const editable = item.state !== "archived";

  const trimmed = draft?.trim() ?? "";
  const invalid =
    draft !== null && (trimmed.length === 0 || trimmed.length > CONTENT_TITLE_MAX_LENGTH);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft === null || invalid) return;
    if (trimmed === item.title) {
      setDraft(null);
      return;
    }
    rename.mutate(trimmed, { onSuccess: () => setDraft(null) });
  };

  if (draft !== null) {
    return (
      <form onSubmit={submit} className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="sr-only">
          Title
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            id={inputId}
            value={draft}
            autoFocus
            maxLength={CONTENT_TITLE_MAX_LENGTH + 20}
            aria-invalid={invalid || rename.isError || undefined}
            aria-describedby={rename.isError || invalid ? errorId : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
              }
            }}
            className="h-9 min-w-0 flex-1 text-[17px] font-semibold"
          />
          <Button type="submit" size="sm" disabled={invalid || rename.isPending}>
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={rename.isPending}
            onClick={() => setDraft(null)}
          >
            Cancel
          </Button>
        </div>
        {invalid || rename.isError ? (
          <p id={errorId} role="alert" className="text-small text-destructive">
            {invalid
              ? `Use 1 to ${CONTENT_TITLE_MAX_LENGTH} characters.`
              : errorMessage(rename.error, "Couldn't rename it. Try again.")}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <div className="group/title flex min-w-0 items-start gap-1">
      <h1 className="min-w-0 break-words text-title">{item.title}</h1>
      {editable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Rename"
          className="mt-0.5 shrink-0"
          onClick={() => {
            rename.reset();
            setDraft(item.title);
          }}
        >
          <PencilIcon aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
