import type { KbEntryDetail, Workspace } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileQuestionIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Markdown } from "@/features/conversation/Markdown";
import { isApiError } from "@/lib/api";
import { useTitle } from "@/lib/use-title";
import { DecisionView } from "./DecisionView";
import { DeleteEntryButton, EntryMeta, EntrySkeleton, EntryToolbar, TagChips } from "./EntryChrome";
import { kbEntryQueryOptions } from "./queries";
import { ReferenceView } from "./ReferenceView";
import { TextEntryEditor } from "./TextEntryEditor";

export interface KbEntryPageProps {
  workspace: Workspace;
  workspaceParam: string;
  /** `null` when the address does not hold a valid id. */
  entryId: string | null;
}

/** One knowledge entry, with the view or editor that fits its kind. */
export function KbEntryPage({ workspace, workspaceParam, entryId }: KbEntryPageProps) {
  const query = useQuery({ ...kbEntryQueryOptions(entryId ?? ""), enabled: entryId !== null });
  const entry = query.data?.workspaceId === workspace.id ? query.data : undefined;
  useTitle(`${entry ? entry.title : "Knowledge"} · ${workspace.name}`);

  if (entryId === null || (query.isSuccess && !entry) || isApiError(query.error, 404)) {
    return (
      <EmptyState
        icon={FileQuestionIcon}
        title="Entry not found"
        description="It may have been deleted, or it belongs to another workspace."
        action={
          <Button asChild variant="outline">
            <Link to="/w/$workspace/kb" params={{ workspace: workspaceParam }}>
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

  switch (entry.kind) {
    case "brainstorm":
    case "note":
      return (
        <TextEntryEditor
          workspace={workspace}
          workspaceParam={workspaceParam}
          kind={entry.kind}
          entry={entry}
        />
      );
    case "decision":
      return <DecisionView workspace={workspace} workspaceParam={workspaceParam} entry={entry} />;
    case "reference":
      return <ReferenceView entry={entry} workspaceParam={workspaceParam} />;
    default:
      return <EntryReadView entry={entry} workspaceParam={workspaceParam} />;
  }
}

/** A read-only entry: title, tags and the markdown body. */
export function EntryReadView({
  entry,
  workspaceParam,
}: {
  entry: KbEntryDetail;
  workspaceParam: string;
}) {
  return (
    <article className="flex flex-col gap-4">
      <EntryToolbar workspaceParam={workspaceParam}>
        <DeleteEntryButton entry={entry} workspaceParam={workspaceParam} />
      </EntryToolbar>
      <header className="flex flex-col gap-2">
        <EntryMeta entry={entry} />
        <h1 className="text-title break-words">{entry.title}</h1>
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
