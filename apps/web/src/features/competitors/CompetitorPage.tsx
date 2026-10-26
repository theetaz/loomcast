import {
  COMPETITOR_NOTES_MAX_LENGTH,
  type Competitor,
  type CompetitorScan,
  type Workspace,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { Textarea } from "@loomcast/ui/components/textarea";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  PencilIcon,
  RadarIcon,
  Trash2Icon,
  UserXIcon,
} from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { PlatformTile, platformLabel } from "@/features/channels/platforms";
import { errorMessage, isApiError } from "@/lib/api";
import { useTitle } from "@/lib/use-title";
import { DeleteCompetitorDialog } from "./ConfirmDialogs";
import {
  competitorQueryOptions,
  competitorScansQueryOptions,
  isActiveScan,
  useUpdateCompetitorNotes,
} from "./queries";
import { ScanDialog } from "./ScanDialog";
import {
  accountFacts,
  analysedCount,
  competitorName,
  ScanStatusPill,
  SOURCE_LABELS,
} from "./status";

export const backLink = cn(
  "inline-flex w-fit items-center gap-1 rounded-sm text-control text-muted-foreground outline-none",
  "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
);

/** One competitor: who it is, the notes on it, and its scans. */
export function CompetitorPage({
  workspace,
  workspaceParam,
  competitorId,
}: {
  workspace: Workspace;
  workspaceParam: string;
  competitorId: string;
}) {
  const query = useQuery(competitorQueryOptions(competitorId));
  const competitor = query.data && query.data.workspaceId === workspace.id ? query.data : null;
  useTitle(competitor ? `${competitorName(competitor)} · ${workspace.name}` : "Competitor");

  const back = (
    <Link
      to="/w/$workspace/competitors"
      params={{ workspace: workspaceParam }}
      className={backLink}
    >
      <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      Competitors
    </Link>
  );

  if (query.isPending) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Skeleton className="h-4 w-24" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-md" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  }

  if (query.isError && !isApiError(query.error, 404)) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <ErrorState
          title="Couldn't load this competitor"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </div>
    );
  }

  if (!competitor) {
    return (
      <EmptyState
        icon={UserXIcon}
        title="Competitor not found"
        description="The workspace may have stopped following it, or the link points somewhere else."
        action={
          <Button asChild variant="outline">
            <Link to="/w/$workspace/competitors" params={{ workspace: workspaceParam }}>
              All competitors
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {back}
      <CompetitorHeader
        competitor={competitor}
        workspace={workspace}
        workspaceParam={workspaceParam}
      />
      <NotesCard competitor={competitor} />
      <ScansSection competitor={competitor} workspaceParam={workspaceParam} />
    </div>
  );
}

function CompetitorHeader({
  competitor,
  workspace,
  workspaceParam,
}: {
  competitor: Competitor;
  workspace: Workspace;
  workspaceParam: string;
}) {
  const navigate = useNavigate();
  const facts = accountFacts(competitor.account);
  const name = competitorName(competitor);
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <PlatformTile platform={competitor.platform} className="mt-0.5 size-9 text-[13px]" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="text-title break-words">
            <a
              href={competitor.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-1.5 rounded-sm outline-none underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{name}</span>
              <ExternalLinkIcon aria-hidden="true" className="size-4 shrink-0 text-text-3" />
              <span className="sr-only">(opens the profile in a new tab)</span>
            </a>
          </h1>
          <p className="text-small text-muted-foreground">
            {[platformLabel(competitor.platform), competitor.account.displayName, ...facts]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {workspace.status === "active" ? (
          <ScanDialog competitor={competitor} workspaceParam={workspaceParam}>
            <Button>
              <RadarIcon aria-hidden="true" />
              Scan
            </Button>
          </ScanDialog>
        ) : null}
        <DeleteCompetitorDialog
          competitor={competitor}
          onDeleted={() =>
            void navigate({
              to: "/w/$workspace/competitors",
              params: { workspace: workspaceParam },
              replace: true,
            })
          }
        >
          <Button variant="outline">
            <Trash2Icon aria-hidden="true" />
            Remove
          </Button>
        </DeleteCompetitorDialog>
      </div>
    </header>
  );
}

function NotesCard({ competitor }: { competitor: Competitor }) {
  const id = useId();
  const update = useUpdateCompetitorNotes(competitor.id);
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft === null || update.isPending) return;
    const notes = draft.trim();
    update.mutate(notes ? notes : null, { onSuccess: () => setDraft(null) });
  };

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-2 rounded-lg bg-card px-3.5 py-3 shadow-card"
    >
      <div className="flex items-center gap-2">
        <h3 id={`${id}-title`} className="flex-1 font-medium text-body">
          Notes
        </h3>
        {editing ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              update.reset();
              setDraft(competitor.notes ?? "");
            }}
          >
            <PencilIcon aria-hidden="true" />
            Edit notes
          </Button>
        )}
      </div>
      {editing ? (
        <form noValidate onSubmit={save} className="flex flex-col gap-2">
          <Textarea
            aria-labelledby={`${id}-title`}
            value={draft}
            maxLength={COMPETITOR_NOTES_MAX_LENGTH}
            rows={3}
            autoFocus
            placeholder="Why this profile is worth following"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
              }
            }}
          />
          {update.error ? (
            <p role="alert" className="text-small text-destructive">
              {errorMessage(update.error, "Couldn't save the notes. Try again.")}
            </p>
          ) : null}
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save notes"}
            </Button>
          </div>
        </form>
      ) : competitor.notes ? (
        <p className="whitespace-pre-line break-words text-body text-foreground">
          {competitor.notes}
        </p>
      ) : (
        <p className="text-control text-muted-foreground">
          No notes yet. Write down why this profile is worth following.
        </p>
      )}
    </section>
  );
}

function ScansSection({
  competitor,
  workspaceParam,
}: {
  competitor: Competitor;
  workspaceParam: string;
}) {
  const id = useId();
  const query = useQuery(competitorScansQueryOptions(competitor.id));
  const scans = query.data?.items ?? [];

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h3 id={`${id}-title`} className="text-heading">
        Scans
      </h3>
      <div className="overflow-hidden rounded-lg bg-card shadow-card">
        {query.isPending ? (
          <div aria-hidden="true" className="flex flex-col gap-2 px-3.5 py-3">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ) : query.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load the scans"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : scans.length === 0 ? (
          <EmptyState
            size="compact"
            icon={RadarIcon}
            title="Not scanned yet"
            description={
              competitor.platform === "instagram"
                ? "Scan to analyse the most viewed Reels, or the videos you paste."
                : `Scan with links to the ${platformLabel(competitor.platform)} videos you want analysed.`
            }
          />
        ) : (
          <ul aria-label={`Scans of ${competitorName(competitor)}`}>
            {scans.map((scan) => (
              <ScanRow
                key={scan.id}
                scan={scan}
                competitor={competitor}
                workspaceParam={workspaceParam}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ScanRow({
  scan,
  competitor,
  workspaceParam,
}: {
  scan: CompetitorScan;
  competitor: Competitor;
  workspaceParam: string;
}) {
  const active = isActiveScan(scan.status);
  return (
    <li className="border-divider border-t first:border-t-0">
      <Link
        to="/w/$workspace/competitors/$competitorId/scans/$scanId"
        params={{ workspace: workspaceParam, competitorId: competitor.id, scanId: scan.id }}
        className={cn(
          "flex items-center gap-3 px-3.5 py-2.5 outline-none transition-colors",
          "hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        )}
      >
        <ScanStatusPill status={scan.status} />
        <span className="min-w-0 flex-1 truncate text-body text-foreground">
          {SOURCE_LABELS[scan.source]} · {scan.videoCount}{" "}
          {scan.videoCount === 1 ? "video" : "videos"}
          {active ? (
            <span className="text-muted-foreground">
              {" "}
              · {analysedCount(scan)} of {scan.videoCount} analysed
            </span>
          ) : null}
        </span>
        <RelativeTime
          value={scan.createdAt}
          format="relative"
          className="shrink-0 text-small text-muted-foreground"
        />
      </Link>
    </li>
  );
}
