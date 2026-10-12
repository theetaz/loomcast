import type { JobSummary, Message, Project } from "../src";

export const ids = {
  user: "4f6d1c2a-8b3e-4a5f-9c7d-1e2f3a4b5c6d",
  project: "0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b",
  conversation: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
  message: "9d8c7b6a-5f4e-4d3c-9b2a-1f0e9d8c7b6a",
  job: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  device: "6c5b4a39-2817-4f06-a5e4-d3c2b1a09f8e",
} as const;

export const at = "2026-10-12T09:30:00.000Z";

export const project: Project = {
  id: ids.project,
  slug: "rust-in-60-seconds",
  name: "Rust in 60 seconds",
  description: null,
  status: "active",
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
};

export const message: Message = {
  id: ids.message,
  conversationId: ids.conversation,
  role: "user",
  authorUserId: ids.user,
  jobId: null,
  clientMessageId: "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918",
  content: { text: "Draft three hooks about ownership." },
  createdAt: at,
};

export const job: JobSummary = {
  id: ids.job,
  type: "producer.chat",
  status: "queued",
  projectId: ids.project,
  conversationId: ids.conversation,
  claimedByDevice: null,
  attempt: 0,
  maxAttempts: 1,
  error: null,
  createdAt: at,
  dispatchedAt: null,
  startedAt: null,
  finishedAt: null,
  cancelRequestedAt: null,
};
