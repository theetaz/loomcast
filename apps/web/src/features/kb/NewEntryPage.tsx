import type { Project } from "@loomcast/contracts";
import { useQuery } from "@tanstack/react-query";
import { useTitle } from "@/lib/use-title";
import { DecisionForm } from "./DecisionForm";
import { EntrySkeleton } from "./EntryChrome";
import { type CreatableKind, KIND_META } from "./kinds";
import { kbEntryQueryOptions } from "./queries";
import { ReferenceIntake } from "./ReferenceIntake";
import { TextEntryEditor } from "./TextEntryEditor";

export interface NewEntryPageProps {
  project: Project;
  projectParam: string;
  kind: CreatableKind;
  /** A decision the new decision replaces. */
  supersedes?: string;
}

/** Creates an entry of one kind with the form that fits it. */
export function NewEntryPage({ project, projectParam, kind, supersedes }: NewEntryPageProps) {
  useTitle(`New ${KIND_META[kind].label.toLowerCase()} · ${project.name}`);
  const previous = useQuery({
    ...kbEntryQueryOptions(supersedes ?? ""),
    enabled: kind === "decision" && supersedes !== undefined,
  });

  switch (kind) {
    case "brainstorm":
    case "note":
      return (
        <TextEntryEditor key={kind} project={project} projectParam={projectParam} kind={kind} />
      );
    case "decision": {
      if (supersedes && previous.isPending) return <EntrySkeleton />;
      const replaced =
        previous.data?.kind === "decision" && previous.data.projectId === project.id
          ? previous.data
          : undefined;
      return (
        <DecisionForm
          key={replaced?.id ?? "new"}
          project={project}
          projectParam={projectParam}
          supersedes={replaced}
        />
      );
    }
    case "reference":
      return <ReferenceIntake project={project} projectParam={projectParam} />;
  }
}
