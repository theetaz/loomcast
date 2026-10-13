import type { Conversation, Message } from "@loomcast/contracts";

/** Oldest first; messages created in the same millisecond keep a stable order by id. */
export function compareMessages(a: Message, b: Message): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** Chronological and without duplicates, whatever order the pages arrived in. */
export function sortMessages(messages: readonly Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of messages) byId.set(message.id, message);
  return [...byId.values()].sort(compareMessages);
}

/** Adds or replaces one message, keeping the list chronological. */
export function upsertMessage(messages: readonly Message[], message: Message): Message[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index >= 0) {
    const next = [...messages];
    next[index] = message;
    return next;
  }
  const next = [...messages, message];
  // Live events almost always arrive in order; sort only when this one does not.
  const previous = messages.at(-1);
  return previous && compareMessages(previous, message) > 0 ? next.sort(compareMessages) : next;
}

export type SendVia = "keyboard" | "pointer";

/** A user message shown before the API stores it. */
export interface PendingMessage {
  clientMessageId: string;
  /** Empty until the first message of a new conversation has created it. */
  conversationId: string;
  text: string;
  status: "sending" | "failed";
  error?: unknown;
  createdAt: string;
  /** Sending from the keyboard never animates the new message in. */
  via: SendVia;
}

export type TimelineItem =
  | { kind: "message"; key: string; message: Message; enter?: SendVia }
  | { kind: "pending"; key: string; pending: PendingMessage };

/**
 * Stored messages followed by the ones still being sent. A pending message
 * disappears as soon as a stored message carries its `clientMessageId`, from
 * the API's answer or from the live event, whichever comes first. Items are
 * keyed by `clientMessageId`, so the stored message takes over the pending
 * one's element instead of mounting a new one.
 */
export function buildTimeline(
  messages: readonly Message[],
  pending: readonly PendingMessage[],
  /** How the messages sent from this tab were sent, by `clientMessageId`. */
  sentVia: ReadonlyMap<string, SendVia> = new Map(),
): TimelineItem[] {
  const stored = new Set<string>();
  const items: TimelineItem[] = messages.map((message) => {
    if (message.clientMessageId) stored.add(message.clientMessageId);
    const enter = message.clientMessageId ? sentVia.get(message.clientMessageId) : undefined;
    return {
      kind: "message",
      key: message.clientMessageId ?? message.id,
      message,
      ...(enter ? { enter } : {}),
    };
  });
  for (const item of pending) {
    if (stored.has(item.clientMessageId)) continue;
    items.push({ kind: "pending", key: item.clientMessageId, pending: item });
  }
  return items;
}

/** Most recent activity first; conversations without messages sort by creation. */
export function sortConversations(conversations: readonly Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => {
    const left = a.lastMessageAt ?? a.createdAt;
    const right = b.lastMessageAt ?? b.createdAt;
    return right.localeCompare(left) || b.id.localeCompare(a.id);
  });
}

const titleDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** The stored title, or when the conversation started. */
export function conversationTitle(conversation: Conversation): string {
  const title = conversation.title?.trim();
  if (title) return title;
  const time = Date.parse(conversation.createdAt);
  return Number.isNaN(time) ? "Untitled conversation" : `Conversation, ${titleDate.format(time)}`;
}
