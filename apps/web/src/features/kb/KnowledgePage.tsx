import type { Workspace } from "@loomcast/contracts";
import { DecisionLog } from "./DecisionLog";
import { KbList, type KbListState } from "./KbList";
import type { KbFilter } from "./kinds";
import { NewEntryButton, NewEntryMenu } from "./NewEntryMenu";

function emptyAction(workspaceParam: string, kind: KbFilter) {
  switch (kind) {
    case "all":
    case "brainstorm":
      return (
        <NewEntryButton workspaceParam={workspaceParam} kind="brainstorm" label="New brainstorm" />
      );
    case "note":
      return <NewEntryButton workspaceParam={workspaceParam} kind="note" label="New note" />;
    case "decision":
      return (
        <NewEntryButton workspaceParam={workspaceParam} kind="decision" label="Record decision" />
      );
    case "reference":
      return (
        <NewEntryButton workspaceParam={workspaceParam} kind="reference" label="Add reference" />
      );
    default:
      return null;
  }
}

export interface KnowledgePageProps {
  workspace: Workspace;
  workspaceParam: string;
  state: KbListState;
  onStateChange: (next: KbListState) => void;
}

/** The Knowledge page: what the workspace knows, and the ways to add to it. */
export function KnowledgePage({
  workspace,
  workspaceParam,
  state,
  onStateChange,
}: KnowledgePageProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="text-title">Knowledge</h1>
          <p className="text-control text-muted-foreground">
            Ideas, references, decisions and notes. The studio agent reads them when it writes.
          </p>
        </div>
        <NewEntryMenu workspaceParam={workspaceParam} />
      </div>
      <KbList
        workspace={workspace}
        workspaceParam={workspaceParam}
        state={state}
        onStateChange={onStateChange}
        emptyAction={(kind) => emptyAction(workspaceParam, kind)}
        renderKind={{
          decision: () => <DecisionLog workspace={workspace} workspaceParam={workspaceParam} />,
        }}
      />
    </div>
  );
}
