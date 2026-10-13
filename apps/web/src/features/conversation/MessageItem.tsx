import type { Message } from "@loomcast/contracts";
import { LoomcastGlyph } from "@loomcast/ui/brand";
import { Button } from "@loomcast/ui/components/button";
import { cn } from "@loomcast/ui/lib/cn";
import { RotateCwIcon } from "lucide-react";
import { memo } from "react";
import { errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { Markdown } from "./Markdown";
import type { PendingMessage, SendVia, TimelineItem } from "./messages";

/**
 * Sent with the pointer, a new message rises in over 160ms; sent from the
 * keyboard it simply appears. Reduced motion keeps only the fade.
 */
const enterMotion = "animate-in fade-in-0 slide-in-from-bottom-1 duration-menu-in";

export interface UserBubbleProps {
  text: string;
  createdAt: string;
  enter?: SendVia | undefined;
  status?: "sending" | "failed" | "sent";
  error?: unknown;
  onRetry?: () => void;
}

/** The user's words, on the right in a muted surface. Stored and pending messages share it. */
export const UserBubble = memo(function UserBubble({
  text,
  createdAt,
  enter,
  status = "sent",
  error,
  onRetry,
}: UserBubbleProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-end gap-1 pl-10 sm:pl-16",
        enter === "pointer" && enterMotion,
      )}
      aria-busy={status === "sending" || undefined}
    >
      <h3 className="sr-only">You said</h3>
      <div
        title={formatDateTime(createdAt)}
        className={cn(
          "max-w-full whitespace-pre-wrap break-words rounded-lg bg-secondary px-3 py-2 text-body text-foreground shadow-[0_0_0_1px_var(--border)]",
          status === "sending" && "text-text-2",
          status === "failed" &&
            "shadow-[0_0_0_1px_color-mix(in_srgb,var(--destructive)_45%,transparent)]",
        )}
      >
        {text}
      </div>
      {/* No visible line while sending: the bubble would jump when it went away. */}
      {status === "sending" ? <span className="sr-only">Sending</span> : null}
      {status === "failed" ? (
        <div role="alert" className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <span className="text-small text-destructive">
            Not sent. {errorMessage(error, "Try again.")}
          </span>
          {onRetry ? (
            <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
              <RotateCwIcon aria-hidden="true" />
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

function AssistantHeader({
  createdAt,
  label = "Studio agent",
}: {
  createdAt?: string;
  label?: string;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-small text-muted-foreground">
      <LoomcastGlyph aria-hidden="true" size={13} className="text-foreground" />
      <h3 className="font-medium text-text-2">{label}</h3>
      {createdAt ? (
        <time dateTime={createdAt} title={formatDateTime(createdAt)} className="sr-only">
          {formatDateTime(createdAt)}
        </time>
      ) : null}
    </div>
  );
}

/** A reply from the studio agent: full width, rendered as markdown. */
export const AssistantMessage = memo(function AssistantMessage({ message }: { message: Message }) {
  return (
    <div className="flex flex-col">
      <AssistantHeader createdAt={message.createdAt} />
      <Markdown text={message.content.text} />
    </div>
  );
});

/** Streaming text before the stored reply replaces it. */
export function DraftMessage({ text, stopped }: { text: string; stopped: boolean }) {
  return (
    <div className="flex flex-col" aria-busy={!stopped || undefined}>
      <AssistantHeader label={stopped ? "Studio agent (stopped)" : "Studio agent"} />
      <Markdown text={text} className={cn(stopped && "text-text-2")} />
    </div>
  );
}

/** System notes and job events, as a quiet centred line. */
export const EventMessage = memo(function EventMessage({ message }: { message: Message }) {
  return (
    <p className="mx-auto max-w-[60ch] text-center text-small text-muted-foreground">
      {message.content.text}
    </p>
  );
});

/**
 * One entry of the timeline. A pending message and the stored message that
 * replaces it render the same `UserBubble` under the same key, so the swap
 * keeps the element: no flash, and an enter animation is never replayed.
 */
export function TimelineEntry({
  item,
  onRetry,
}: {
  item: TimelineItem;
  onRetry: (pending: PendingMessage) => void;
}) {
  if (item.kind === "pending") {
    const { pending } = item;
    return (
      <UserBubble
        text={pending.text}
        createdAt={pending.createdAt}
        enter={pending.via}
        status={pending.status}
        error={pending.error}
        onRetry={() => onRetry(pending)}
      />
    );
  }
  const { message } = item;
  if (message.role === "user") {
    return (
      <UserBubble text={message.content.text} createdAt={message.createdAt} enter={item.enter} />
    );
  }
  if (message.role === "assistant") return <AssistantMessage message={message} />;
  return <EventMessage message={message} />;
}
