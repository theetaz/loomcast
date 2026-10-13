import type { JobSummary, Message } from "@loomcast/contracts";
import { useSyncExternalStore } from "react";
import type { PendingMessage, SendVia } from "./messages";

/** Assistant text streamed for one job, before the stored message replaces it. */
export interface StreamDraft {
  jobId: string;
  conversationId: string;
  text: string;
}

export interface JobActivity {
  kind: string;
  summary: string;
}

/** The job that answers a conversation's latest message, as far as this tab knows. */
export interface TrackedJob {
  jobId: string;
  createdAt: string;
}

/**
 * Everything the panel knows that the API does not store: messages on their
 * way to the server, streaming text, the latest tool activity per job, and
 * which job answers each conversation. It lives as long as the panel.
 */
export interface ConversationState {
  pending: readonly PendingMessage[];
  /** By job id. */
  drafts: Readonly<Record<string, StreamDraft>>;
  /** By job id. */
  activity: Readonly<Record<string, JobActivity>>;
  /** By conversation id. */
  jobs: Readonly<Record<string, TrackedJob>>;
  /** The text that started each job, by job id, so Retry can send it again. */
  prompts: Readonly<Record<string, string>>;
  /** How each message sent from this tab was sent, by `clientMessageId`. */
  sentVia: ReadonlyMap<string, SendVia>;
}

export const EMPTY_STATE: ConversationState = {
  pending: [],
  drafts: {},
  activity: {},
  jobs: {},
  prompts: {},
  sentVia: new Map(),
};

/** Appends a streamed chunk to its job's draft. */
export function appendDelta(
  drafts: ConversationState["drafts"],
  delta: { conversationId: string; jobId: string; text: string },
): ConversationState["drafts"] {
  if (!delta.text) return drafts;
  const current = drafts[delta.jobId];
  return {
    ...drafts,
    [delta.jobId]: {
      jobId: delta.jobId,
      conversationId: delta.conversationId,
      text: (current?.text ?? "") + delta.text,
    },
  };
}

/**
 * A stored assistant message replaces the text streamed for it. A job can
 * write several messages, so when the draft already runs past the stored text
 * the rest stays as the start of the next one.
 */
export function settleDraft(
  drafts: ConversationState["drafts"],
  message: Pick<Message, "jobId" | "role" | "content">,
): ConversationState["drafts"] {
  if (message.role !== "assistant" || !message.jobId) return drafts;
  const draft = drafts[message.jobId];
  if (!draft) return drafts;
  const { [message.jobId]: _settled, ...rest } = drafts;
  const stored = message.content.text;
  if (stored && draft.text.startsWith(stored)) {
    const remainder = draft.text.slice(stored.length).replace(/^\s+/, "");
    if (remainder) return { ...rest, [message.jobId]: { ...draft, text: remainder } };
  }
  return rest;
}

/** Keeps the newest job per conversation. */
export function trackJob(
  jobs: ConversationState["jobs"],
  conversationId: string,
  job: TrackedJob,
): ConversationState["jobs"] {
  const current = jobs[conversationId];
  if (current?.jobId === job.jobId) return jobs;
  if (current && current.createdAt > job.createdAt) return jobs;
  return { ...jobs, [conversationId]: job };
}

function omit<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export interface ConversationStore {
  getState(): ConversationState;
  subscribe(listener: () => void): () => void;
  addPending(message: PendingMessage): void;
  updatePending(clientMessageId: string, patch: Partial<PendingMessage>): void;
  removePending(clientMessageId: string): void;
  appendDelta(delta: { conversationId: string; jobId: string; text: string }): void;
  settleDraft(message: Message): void;
  clearDraft(jobId: string): void;
  /** Drops what was left of stopped replies before a new message goes out. */
  clearDrafts(conversationId: string): void;
  setActivity(jobId: string, activity: JobActivity): void;
  clearActivity(jobId: string): void;
  trackJob(job: Pick<JobSummary, "id" | "conversationId" | "createdAt">, prompt?: string): void;
}

export function createConversationStore(
  initial: ConversationState = EMPTY_STATE,
): ConversationStore {
  let state = initial;
  const listeners = new Set<() => void>();

  function set(next: Partial<ConversationState>) {
    const merged = { ...state, ...next };
    const changed = (Object.keys(next) as (keyof ConversationState)[]).some(
      (key) => merged[key] !== state[key],
    );
    if (!changed) return;
    state = merged;
    for (const listener of listeners) listener();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addPending(message) {
      const sentVia = new Map(state.sentVia);
      sentVia.set(message.clientMessageId, message.via);
      set({
        pending: [
          ...state.pending.filter((item) => item.clientMessageId !== message.clientMessageId),
          message,
        ],
        sentVia,
      });
    },
    updatePending(clientMessageId, patch) {
      if (!state.pending.some((item) => item.clientMessageId === clientMessageId)) return;
      set({
        pending: state.pending.map((item) =>
          item.clientMessageId === clientMessageId ? { ...item, ...patch } : item,
        ),
      });
    },
    removePending(clientMessageId) {
      if (!state.pending.some((item) => item.clientMessageId === clientMessageId)) return;
      set({ pending: state.pending.filter((item) => item.clientMessageId !== clientMessageId) });
    },
    appendDelta(delta) {
      set({ drafts: appendDelta(state.drafts, delta) });
    },
    settleDraft(message) {
      set({ drafts: settleDraft(state.drafts, message) });
    },
    clearDraft(jobId) {
      set({ drafts: omit(state.drafts, jobId) });
    },
    clearDrafts(conversationId) {
      const drafts = Object.fromEntries(
        Object.entries(state.drafts).filter(([, draft]) => draft.conversationId !== conversationId),
      );
      if (Object.keys(drafts).length !== Object.keys(state.drafts).length) set({ drafts });
    },
    setActivity(jobId, activity) {
      const current = state.activity[jobId];
      if (current?.kind === activity.kind && current.summary === activity.summary) return;
      set({ activity: { ...state.activity, [jobId]: activity } });
    },
    clearActivity(jobId) {
      set({ activity: omit(state.activity, jobId) });
    },
    trackJob(job, prompt) {
      const next: Partial<ConversationState> = {};
      if (job.conversationId) {
        next.jobs = trackJob(state.jobs, job.conversationId, {
          jobId: job.id,
          createdAt: job.createdAt,
        });
      }
      if (prompt !== undefined && state.prompts[job.id] !== prompt) {
        next.prompts = { ...state.prompts, [job.id]: prompt };
      }
      set(next);
    },
  };
}

/** Reads a slice of the store; the selector must return stored values, not new objects. */
export function useConversationStore<T>(
  store: ConversationStore,
  selector: (state: ConversationState) => T,
): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
