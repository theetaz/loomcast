import type { KbEntryDetail, Project } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileQuestionIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Markdown } from "@/features/conversation/Markdown";
import { isApiError } from "@/lib/api";
import { useTitle } from "@/lib/use-title";
import { DeleteEntryButton, EntryMeta, EntrySkeleton, EntryToolbar, TagChips } from "./EntryChrome";
import { kbEntryQueryOptions } from "./queries";

export function KbEntryCrumb({ id }: { id: string }) {
  const query = useQuery({ ...kbEntryQueryOptions(id), enabled: id !== "" });
  if (query.data) return <>{query.data.title}</>;
  if (query.isPending)
    return <Skeleton aria-hidden="true" className="inline-block h-3 w-28 align-middle" />;
  return <>Entry</>;
}

export interface KbEntryPageProps {
  project: Project;
  projectParam: string;
  /** `null` when the address does not hold a valid id. */
  entryId: string | null;
}

/** One knowledge entry, with the view or editor that fits its kind. */
export function KbEntryPage({ project, projectParam, entryId }: KbEntryPageProps) {
  const query = useQuery({ ...kbEntryQueryOptions(entryId ?? ""), enabled: entryId !== null });
  const entry = query.data?.projectId === project.id ? query.data : undefined;
  useTitle(`${entry ? entry.title : "Knowledge"} · ${project.name}`);

  if (entryId === null || (query.isSuccess && !entry) || isApiError(query.error, 404)) {
    return (
      <EmptyState
        icon={FileQuestionIcon}
        title="Entry not found"
        description="It may have been deleted, or it belongs to another project."
        action={
          <Button asChild variant="outline">
            <Link to="/projects/$projectId/kb" params={{ projectId: projectParam }}>
              Back to knowledge
            </Link>
          </Button>
        }
      />
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load this entry"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (!entry) return <EntrySkeleton />;

  return <EntryReadView entry={entry} projectParam={projectParam} />;
}

/** A read-only entry: title, tags and the markdown body. */
export function EntryReadView({
  entry,
  projectParam,
}: {
  entry: KbEntryDetail;
  projectParam: string;
}) {
  return (
    <article className="flex flex-col gap-4">
      <EntryToolbar projectParam={projectParam}>
        <DeleteEntryButton entry={entry} projectParam={projectParam} />
      </EntryToolbar>
      <header className="flex flex-col gap-2">
        <EntryMeta entry={entry} />
        <h2 className="text-title break-words">{entry.title}</h2>
        <TagChips tags={entry.tags} />
      </header>
      <div className="rounded-lg bg-card px-4 py-3.5 shadow-card md:px-5">
        {entry.bodyMd.trim() ? (
          <Markdown text={entry.bodyMd} className="max-w-[72ch]" />
        ) : (
          <p className="text-body text-muted-foreground">This entry has no text.</p>
        )}
      </div>
    </article>
  );
}
