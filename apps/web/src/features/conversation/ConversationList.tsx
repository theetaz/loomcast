import type { Conversation } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@loomcast/ui/components/tooltip";
import { cn } from "@loomcast/ui/lib/cn";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import { conversationTitle } from "./messages";

export interface ConversationListProps {
  /** The project's id or slug as it appears in the address. */
  projectParam: string;
  conversations: readonly Conversation[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  creating: boolean;
  loading: boolean;
}

/** The left column from 768px up: the project's conversations, latest first. */
export function ConversationColumn({
  projectParam,
  conversations,
  selectedId,
  onNew,
  creating,
  loading,
}: ConversationListProps) {
  return (
    <div className="flex w-[220px] shrink-0 flex-col border-divider border-r max-md:hidden">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-divider border-b pr-1.5 pl-3.5">
        <h2 className="font-semibold text-[13px]">Conversations</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onNew}
              disabled={creating}
              aria-label="New conversation"
            >
              <PlusIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">New conversation</TooltipContent>
        </Tooltip>
      </div>
      <nav aria-label="Conversations" className="relative min-h-0 flex-1">
        <div className="absolute inset-0 overflow-y-auto p-1.5">
          {loading ? (
            <div aria-hidden="true" className="flex flex-col gap-1">
              {[72, 56, 64].map((width) => (
                <div key={width} className="flex h-9 items-center gap-2 px-2">
                  <Skeleton className="h-3" style={{ width: `${width}%` }} />
                </div>
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <p className="px-2 py-2 text-small text-muted-foreground">
              No conversations yet. Your first message starts one.
            </p>
          ) : (
            <ul className="flex flex-col gap-px">
              {conversations.map((conversation) => {
                const active = conversation.id === selectedId;
                return (
                  <li key={conversation.id}>
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: projectParam }}
                      search={{ conversation: conversation.id }}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-9 items-center gap-2 rounded-md px-2 text-control outline-none transition-colors",
                        "hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring",
                        active ? "bg-foreground/6 text-foreground" : "text-text-2",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {conversationTitle(conversation)}
                      </span>
                      <RelativeTime
                        value={conversation.lastMessageAt ?? conversation.createdAt}
                        className="shrink-0 font-mono text-[11px] text-muted-foreground"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </nav>
    </div>
  );
}

/** Below 768px the list folds into a picker above the thread. */
export function ConversationPicker({
  conversations,
  selectedId,
  onSelect,
  onNew,
  creating,
  loading,
}: ConversationListProps) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-divider border-b px-2 md:hidden">
      {loading ? (
        <Skeleton aria-hidden="true" className="h-6.5 flex-1" />
      ) : conversations.length === 0 ? (
        <h2 className="min-w-0 flex-1 truncate px-1.5 font-semibold text-[13px]">
          New conversation
        </h2>
      ) : (
        <Select value={selectedId ?? ""} onValueChange={onSelect}>
          <SelectTrigger size="sm" aria-label="Conversation" className="min-w-0 flex-1">
            <SelectValue placeholder="Choose a conversation" />
          </SelectTrigger>
          <SelectContent>
            {conversations.map((conversation) => (
              <SelectItem key={conversation.id} value={conversation.id}>
                {conversationTitle(conversation)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onNew}
        disabled={creating}
        aria-label="New conversation"
      >
        <PlusIcon aria-hidden="true" />
        New
      </Button>
    </div>
  );
}
