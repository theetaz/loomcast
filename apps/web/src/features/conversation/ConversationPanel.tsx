import type { Project } from "@loomcast/contracts";
import { MessagesSquareIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";

export interface ConversationPanelProps {
  project: Project;
}

/**
 * Slot for the project's conversations with the studio agent. This placeholder
 * keeps the project page complete until the conversation panel lands.
 */
export function ConversationPanel({ project }: ConversationPanelProps) {
  return (
    <section
      aria-label={`Conversations in ${project.name}`}
      className="flex min-h-[320px] flex-1 flex-col rounded-lg bg-card shadow-card"
    >
      <div className="flex h-11 items-center border-divider border-b px-3.5">
        <h2 className="font-semibold text-[13px]">Conversations</h2>
      </div>
      <EmptyState
        className="flex-1"
        icon={MessagesSquareIcon}
        title="Conversations are on the way"
        description="Chat with the studio agent about this project here: draft scripts, research topics and plan videos."
      />
    </section>
  );
}
