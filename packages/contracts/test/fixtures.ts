import type {
  Asset,
  ContentItem,
  ContentVersion,
  ContentVersionSummary,
  JobSummary,
  KbEntry,
  Message,
  Project,
  ReferenceAnalysis,
  Review,
  Script,
  SkillVersionSummary,
  Storyboard,
  VoiceAlignment,
} from "../src";

export const ids = {
  user: "4f6d1c2a-8b3e-4a5f-9c7d-1e2f3a4b5c6d",
  project: "0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b",
  conversation: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
  message: "9d8c7b6a-5f4e-4d3c-9b2a-1f0e9d8c7b6a",
  job: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  device: "6c5b4a39-2817-4f06-a5e4-d3c2b1a09f8e",
  entry: "3e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b",
  item: "8b7a6f5e-4d3c-4b2a-9f1e-0d9c8b7a6f5e",
  version: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
  voice: "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2190",
  render: "4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d",
  poster: "9e8d7c6b-5a49-4382-a716-05f4e3d2c1b0",
  review: "6d7e8f90-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  series: "0f1e2d3c-4b5a-4697-8877-665544332211",
  format: "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716",
  formatVersion: "3b4c5d6e-7f80-4192-a3b4-c5d6e7f80912",
  skill: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b",
  asset: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
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

export const kbEntry: KbEntry = {
  id: ids.entry,
  projectId: ids.project,
  kind: "decision",
  title: "Open every video with the result",
  bodyMd: "Viewers decide in the first second.",
  tags: ["hooks", "format"],
  data: { decision: "Show the finished result first", status: "active" },
  sourceUrl: null,
  conversationId: ids.conversation,
  createdVia: "ui",
  createdBy: ids.user,
  createdAt: at,
  updatedAt: at,
};

export const analysis: ReferenceAnalysis = {
  hook: { text: "This one line saves you an hour", type: "bold-claim", timeToHookMs: 800 },
  structure: [
    { label: "Hook", startMs: 0, endMs: 2_000, summary: "States the payoff up front." },
    { label: "Demo", startMs: 2_000, endMs: 24_000, summary: "Shows the command running." },
  ],
  pacing: { wordsPerMinute: 190, cutsPerMinute: 24, notes: "A cut on every sentence." },
  retention: [{ technique: "Open loop", evidence: "Promises a second trick at the end." }],
  visualStyle: "Terminal close-ups with bold captions.",
  cta: "Follow for part two.",
  takeaways: ["Show the result in the first second."],
  applicability: "Fits the Rust series: lead with the compiler output.",
};

export const script: Script = {
  title: "Borrowing in one minute",
  hook: "Rust will not let you hold two pens at once.",
  segments: [
    { id: "s1", text: "Rust will not let you hold two pens at once." },
    {
      id: "s2",
      text: "One mutable borrow, or many shared ones.",
      onScreenText: "&mut or &, never both",
    },
    { id: "s3", text: "Follow for part two." },
  ],
  cta: "Follow for part two.",
  caption: "The borrow checker in one rule.",
  hashtags: ["rustlang", "programming"],
  estimatedDurationMs: 32_000,
};

export const storyboard: Storyboard = {
  styleId: "vox-explainer",
  fps: 30,
  aspect: "9:16",
  frames: [
    {
      id: "f1",
      segmentId: "s1",
      startMs: 0,
      endMs: 6_000,
      cardId: "vox-explainer.t1.section.circle",
      slots: { kicker: "Rust", headline: "Two pens, one hand" },
    },
    {
      id: "f2",
      segmentId: "s2",
      startMs: 6_000,
      endMs: 14_000,
      cardId: "vox-explainer.t1.section.markerbox",
      slots: { line1: "&mut", line2: "or", line3: "&" },
      notes: "Hold on the rule.",
    },
  ],
};

export const alignment: VoiceAlignment = {
  words: [
    { text: "Rust", startMs: 0, endMs: 320 },
    { text: "will", startMs: 320, endMs: 480 },
    { text: "not", startMs: 480, endMs: 700 },
  ],
};

export const contentItem: ContentItem = {
  id: ids.item,
  projectId: ids.project,
  seriesId: ids.series,
  title: "Borrowing in one minute",
  pitch: "The borrow checker as one rule.",
  topic: null,
  state: "review",
  currentVersionId: ids.version,
  versionNo: 4,
  durationMs: 41_000,
  posterAssetId: ids.poster,
  targetAt: at,
  autopilotTarget: null,
  lastError: null,
  createdVia: "ui",
  createdBy: ids.user,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
};

export const versionSummary: ContentVersionSummary = {
  id: ids.version,
  itemId: ids.item,
  versionNo: 4,
  stage: "review",
  parentVersionId: null,
  formatVersionId: ids.formatVersion,
  hasScript: true,
  hasStoryboard: true,
  voiceAssetId: ids.voice,
  renderAssetId: ids.render,
  posterAssetId: ids.poster,
  notes: null,
  createdVia: "job",
  createdByUser: null,
  jobId: ids.job,
  createdAt: at,
};

export const version: ContentVersion = {
  ...versionSummary,
  script,
  storyboard,
  caption: null,
};

export const asset: Asset = {
  id: ids.render,
  projectId: ids.project,
  itemId: ids.item,
  kind: "render",
  status: "ready",
  filename: "final.mp4",
  mime: "video/mp4",
  bytes: 12_345_678,
  sha256: "a".repeat(64),
  width: 1080,
  height: 1920,
  durationMs: 41_000,
  probe: { durationMs: 41_000, width: 1080, height: 1920, fps: 30, videoCodec: "h264" },
  createdAt: at,
  finalizedAt: at,
};

export const review: Review = {
  id: ids.review,
  itemId: ids.item,
  versionId: ids.version,
  decision: "request_changes",
  comment: "Open on the error message instead.",
  enqueueRevision: true,
  userId: ids.user,
  actorKind: "user",
  createdAt: at,
};

export const skillVersion: SkillVersionSummary = {
  skillId: ids.skill,
  name: "scriptwriting",
  kind: "skill",
  version: 3,
  checksum: "b".repeat(64),
  changelog: "Tighter hooks.",
  fileCount: 2,
  bytes: 4_096,
  publishedByUser: ids.user,
  publishedAt: at,
};

/** A fresh value per run, so the suite holds no credential-like literals. */
export const fakeSecret = (label: string): string => `${label}-${crypto.randomUUID()}`;
