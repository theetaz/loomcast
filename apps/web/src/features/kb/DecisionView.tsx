import type { KbEntryDetail, Project } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PencilIcon, ReplaceIcon } from "lucide-react";
import { useState } from "react";
import { DecisionForm } from "./DecisionForm";
import { DecisionPill, decisionOf } from "./decisions";
import { DeleteEntryButton, EntryMeta, EntryToolbar, TagChips } from "./EntryChrome";
import { kbEntryQueryOptions } from "./queries";

/** A decision: what, why, its status and what replaced it. Edit opens the form in place. */
export function DecisionView({
  project,
  projectParam,
  entry,
}: {
  project: Project;
  projectParam: string;
  entry: KbEntryDetail;
}) {
  const [editing, setEditing] = useState(false);
  const data = decisionOf(entry);

  if (editing) {
    return (
      <DecisionForm
        project={project}
        projectParam={projectParam}
        entry={entry}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <article className="flex flex-col gap-4">
      <EntryToolbar projectParam={projectParam}>
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          <PencilIcon aria-hidden="true" />
          Edit
        </Button>
        <DeleteEntryButton entry={entry} projectParam={projectParam} />
        {data.status === "active" ? (
          <Button asChild variant="outline" size="sm">
            <Link
              to="/projects/$projectId/kb/new"
              params={{ projectId: projectParam }}
              search={{ kind: "decision", supersedes: entry.id }}
            >
              <ReplaceIcon aria-hidden="true" />
              Supersede
            </Link>
          </Button>
        ) : null}
      </EntryToolbar>

      <header className="flex flex-col gap-2">
        <EntryMeta entry={entry}>
          <DecisionPill status={data.status} />
        </EntryMeta>
        <h2 className="text-title break-words">{entry.title}</h2>
        <TagChips tags={entry.tags} />
      </header>

      {data.supersededBy ? (
        <SupersededBy id={data.supersededBy} projectParam={projectParam} />
      ) : null}

      <div className="flex flex-col gap-4 rounded-lg bg-card px-4 py-3.5 shadow-card md:px-5">
        <section className="flex flex-col gap-1">
          <h3 className="text-small text-muted-foreground">Decision</h3>
          <p className="max-w-[72ch] whitespace-pre-line break-words text-[15px] text-foreground leading-relaxed">
            {data.decision}
          </p>
        </section>
        <section className="flex flex-col gap-1">
          <h3 className="text-small text-muted-foreground">Why</h3>
          {data.rationale ? (
            <p className="max-w-[72ch] whitespace-pre-line break-words text-body text-text-2">
              {data.rationale}
            </p>
          ) : (
            <p className="text-body text-muted-foreground">No reasons recorded.</p>
          )}
        </section>
      </div>
    </article>
  );
}

function SupersededBy({ id, projectParam }: { id: string; projectParam: string }) {
  const query = useQuery(kbEntryQueryOptions(id));
  return (
    <p className="flex flex-wrap items-center gap-1.5 rounded-lg bg-secondary px-3.5 py-2.5 text-body shadow-[0_0_0_1px_var(--border)]">
      <ReplaceIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      Superseded by
      <Link
        to="/projects/$projectId/kb/$entryId"
        params={{ projectId: projectParam, entryId: id }}
        className="min-w-0 truncate rounded-sm font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {query.data?.title ?? "a later decision"}
      </Link>
    </p>
  );
}
