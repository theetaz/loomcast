// Types for session-end.mjs, which stays plain JavaScript so it runs without a build step.

export declare const TOOL_NAME: "kb.save_session_summary";
export declare const POST_TIMEOUT_MS: number;
export declare const REDACTED: string;
export declare const REDACTED_LINE: string;
export declare const LIMITS: Readonly<{
  prompt: number;
  headline: number;
  reply: number;
  files: number;
  path: number;
  stdinBytes: number;
  transcriptBytes: number;
  lineChars: number;
}>;

export type HookEnv = Record<string, string | undefined>;

export interface HookPayload {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
}

export interface TranscriptDigest {
  firstPrompt: string | undefined;
  lastReply: string | undefined;
  editedFiles: string[];
  toolCounts: Record<string, number>;
  messages: number;
  startedAt: number | undefined;
  endedAt: number | undefined;
  durationMs: number | undefined;
}

export interface ResolvedProject {
  projectId: string;
  /** `env`, or the path of the `.loomcast/project.json` that named it. */
  source: string;
}

export type PostOutcome = { ok: true; entryId: string | undefined } | { ok: false; reason: string };

export interface HookOutcome {
  status: "disabled" | "skipped" | "saved" | "failed";
  detail: string;
}

export declare function redact(text: string): string;
export declare function isEnabled(env: HookEnv): boolean;
export declare function readStdin(
  stream: NodeJS.ReadableStream & { isTTY?: boolean },
  options?: { limit?: number; timeoutMs?: number },
): Promise<string>;
export declare function parsePayload(text: string): HookPayload;
export declare function resolveProject(options: {
  cwd: string | undefined;
  env: HookEnv;
}): Promise<ResolvedProject | null>;
export declare function digestTranscript(path: string | undefined): Promise<TranscriptDigest>;
export declare function formatDuration(ms: number): string;
export declare function renderSummary(options: {
  sessionId: string;
  cwd: string | undefined;
  digest: TranscriptDigest;
}): string;
export declare function endpointUrl(base: string): URL;
export declare function parseRpcResponse(
  contentType: string | null,
  body: string,
  id: number,
): Record<string, unknown> | undefined;
export declare function postSummary(options: {
  url: URL | string;
  token: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<PostOutcome>;
export declare function run(options: {
  stdin: string | (NodeJS.ReadableStream & { isTTY?: boolean });
  env?: HookEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<HookOutcome>;
