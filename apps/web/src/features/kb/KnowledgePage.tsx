import type { Project } from "@loomcast/contracts";
import { KbList, type KbListState } from "./KbList";

export interface KnowledgePageProps {
  project: Project;
  projectParam: string;
  state: KbListState;
  onStateChange: (next: KbListState) => void;
}

/** The Knowledge tab: what the project knows, and the ways to add to it. */
export function KnowledgePage({ project, projectParam, state, onStateChange }: KnowledgePageProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-heading">Knowledge</h2>
          <p className="text-control text-muted-foreground">
            Ideas, references, decisions and notes. The studio agent reads them when it writes.
          </p>
        </div>
      </div>
      <KbList
        project={project}
        projectParam={projectParam}
        state={state}
        onStateChange={onStateChange}
      />
    </div>
  );
}
