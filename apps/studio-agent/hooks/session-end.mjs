#!/usr/bin/env node
/**
 * Loomcast session-end hook: files a short summary of a finished working session in a workspace's
 * knowledge base through the `kb.save_session_summary` MCP tool.
 *
 * Any client that runs a session-end hook with a JSON payload on stdin can use it. The payload
 * names the session, its transcript (JSON Lines) and its working directory:
 *
 *   {"session_id": "…", "transcript_path": "/…/session.jsonl", "cwd": "/…"}
 *
 * It is off by default and never fails a session: it always exits 0, gives up on the server after
 * 5 seconds, and only writes a one-line note to stderr. Secrets are redacted from the summary
 * before it leaves the machine. Plain Node, no dependencies.
 *
 * Environment:
 *   LOOMCAST_SESSION_HOOK  1 (or true, on, yes) turns the hook on
 *   LOOMCAST_URL           the Loomcast server, for example https://loomcast.example.com
 *   LOOMCAST_MCP_TOKEN     an access token with write access
 *   LOOMCAST_WORKSPACE_ID    optional; else `.loomcast/workspace.json` above `cwd`, else the server
 *                          matches a `Loomcast/projects/<workspace id>` folder in `cwd`
 */
import { createReadStream, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const TOOL_NAME = "kb.save_session_summary";
/** How long the server gets to answer, including the response body. */
export const POST_TIMEOUT_MS = 5_000;
/** The process exits after this, whatever is still pending. */
const WATCHDOG_MS = 9_000;
/** How long to wait for the payload on stdin. */
const STDIN_TIMEOUT_MS = 2_000;

export const LIMITS = Object.freeze({
  /** Characters kept of the first prompt. */
  prompt: 600,
  /** Characters of the first prompt line used as the summary's heading. */
  headline: 100,
  /** Characters kept of the last reply. */
  reply: 3_000,
  /** Edited files listed. */
  files: 50,
  /** Characters kept of one file path. */
  path: 300,
  /** Bytes read from stdin. */
  stdinBytes: 1024 * 1024,
  /** Bytes of transcript read; the rest is ignored. */
  transcriptBytes: 64 * 1024 * 1024,
  /** Characters of one transcript line that are parsed; longer lines are skipped. */
  lineChars: 4 * 1024 * 1024,
});

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ON_VALUES = new Set(["1", "true", "on", "yes"]);
/** Tool names whose `file_path`-like input is a file the session changed. */
const EDIT_TOOL_RE = /edit|write|patch|create|notebook|replace|insert/i;
/** A user message that is only client-injected context wrapped in one tag. */
const WRAPPED_RE = /^<([A-Za-z][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/;

/**
 * Secret shapes removed from the summary. Each pattern replaces the whole match. Lines that set a
 * password are dropped entirely.
 */
const SECRET_PATTERNS = [
  /\blc_[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi;
const PASSWORD_LINE_RE = /^.*pass(?:word|wd)[\w-]*["']?\s*[:=].*$/gim;
export const REDACTED = "[redacted]";
export const REDACTED_LINE = "[line redacted]";

/** Removes tokens, keys and password lines from `text`. */
export function redact(text) {
  let out = text.replace(PASSWORD_LINE_RE, REDACTED_LINE);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out.replace(BEARER_RE, `$1 ${REDACTED}`);
}

/** Whether the hook is switched on. */
export function isEnabled(env) {
  return ON_VALUES.has(
    String(env.LOOMCAST_SESSION_HOOK ?? "")
      .trim()
      .toLowerCase(),
  );
}

/** Reads stdin up to `limit` bytes, or gives up after `timeoutMs`. A terminal counts as empty. */
export function readStdin(
  stream,
  { limit = LIMITS.stdinBytes, timeoutMs = STDIN_TIMEOUT_MS } = {},
) {
  if (stream.isTTY) {
    return Promise.resolve("");
  }
  return new Promise((resolveText) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", finish);
      stream.off("error", finish);
      stream.pause();
      resolveText(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const room = limit - size;
      chunks.push(buffer.subarray(0, Math.max(0, room)));
      size += buffer.length;
      if (size >= limit) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.on("data", onData);
    stream.once("end", finish);
    stream.once("error", finish);
  });
}

function stringField(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The session, transcript and folder named by the hook payload; unknown fields are ignored. */
export function parsePayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  return {
    sessionId: stringField(data.session_id) ?? stringField(data.sessionId),
    transcriptPath: stringField(data.transcript_path) ?? stringField(data.transcriptPath),
    cwd: stringField(data.cwd),
  };
}

/**
 * The workspace the summary belongs to: `LOOMCAST_WORKSPACE_ID`, else the `workspaceId` in the nearest
 * `.loomcast/workspace.json` at or above `cwd`. Null when neither names one; the server then tries
 * the `Loomcast/projects/<workspace id>` folder in `cwd`.
 */
export async function resolveWorkspace({ cwd, env }) {
  const fromEnv = String(env.LOOMCAST_WORKSPACE_ID ?? "").trim();
  if (fromEnv !== "") {
    return ID_RE.test(fromEnv) ? { workspaceId: fromEnv.toLowerCase(), source: "env" } : null;
  }
  if (cwd === undefined || !isAbsolute(cwd)) {
    return null;
  }
  let dir = resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    const file = join(dir, ".loomcast", "workspace.json");
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      // The nearest file decides, even when it is unusable.
      try {
        const data = JSON.parse(text);
        const id = typeof data?.workspaceId === "string" ? data.workspaceId.trim() : "";
        return ID_RE.test(id) ? { workspaceId: id.toLowerCase(), source: file } : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block && typeof block === "object" && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

function toolUses(record, content) {
  const uses = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block.type === "tool_use" || block.type === "tool_call" || block.type === "function_call")
      ) {
        uses.push({ name: block.name, input: block.input ?? block.arguments });
      }
    }
  }
  if (record.type === "tool_use" && typeof record.name === "string") {
    uses.push({ name: record.name, input: record.input });
  }
  return uses.filter((use) => typeof use.name === "string" && use.name !== "");
}

function editedPath(use) {
  if (!EDIT_TOOL_RE.test(use.name)) return undefined;
  let input = use.input;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (input === null || typeof input !== "object") return undefined;
  return (
    stringField(input.file_path) ??
    stringField(input.filePath) ??
    stringField(input.notebook_path) ??
    stringField(input.path)
  );
}

function timestampOf(record) {
  const value = record.timestamp ?? record.time ?? record.created_at;
  const ms =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** The parts of a transcript line the digest uses, or null for lines it skips. */
function readRecord(line) {
  if (line.length > LIMITS.lineChars || line.trim() === "") return null;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const message =
    record.message && typeof record.message === "object" && !Array.isArray(record.message)
      ? record.message
      : record;
  return {
    record,
    role: message.role ?? record.role ?? record.type,
    content: message.content ?? record.content,
    // Context the client added, and side conversations, are not what the user asked.
    aside: record.isMeta === true || record.isSidechain === true,
  };
}

/**
 * Digests a JSON Lines transcript: the first user prompt, the last assistant reply, the files
 * edited, tool use counts and the time from the first to the last timestamped line. Lines that do
 * not parse are skipped, and a missing transcript gives an empty digest.
 */
export async function digestTranscript(path) {
  const digest = {
    firstPrompt: undefined,
    lastReply: undefined,
    editedFiles: [],
    toolCounts: {},
    messages: 0,
    startedAt: undefined,
    endedAt: undefined,
    durationMs: undefined,
  };
  if (path === undefined || !isAbsolute(path)) {
    return digest;
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) return digest;
  } catch {
    return digest;
  }
  const edited = new Set();
  const stream = createReadStream(path, {
    encoding: "utf8",
    start: 0,
    end: LIMITS.transcriptBytes - 1,
  });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      const entry = readRecord(line);
      if (entry === null) continue;
      const { record, role, content, aside } = entry;
      const at = timestampOf(record);
      if (at !== undefined) {
        digest.startedAt = digest.startedAt === undefined ? at : Math.min(digest.startedAt, at);
        digest.endedAt = digest.endedAt === undefined ? at : Math.max(digest.endedAt, at);
      }
      for (const use of toolUses(record, content)) {
        digest.toolCounts[use.name] = (digest.toolCounts[use.name] ?? 0) + 1;
        const file = editedPath(use);
        if (file !== undefined && edited.size < LIMITS.files) edited.add(file);
      }
      if (role !== "user" && role !== "assistant") continue;
      const text = textOf(content).trim();
      if (text === "") continue;
      digest.messages += 1;
      if (aside) continue;
      if (role === "user" && digest.firstPrompt === undefined && !WRAPPED_RE.test(text)) {
        digest.firstPrompt = text;
      } else if (role === "assistant") {
        digest.lastReply = text;
      }
    }
  } catch {
    // An unreadable transcript yields what was read so far.
  } finally {
    lines.close();
    stream.destroy();
  }
  digest.editedFiles = [...edited];
  if (digest.startedAt !== undefined && digest.endedAt !== undefined) {
    digest.durationMs = digest.endedAt - digest.startedAt;
  }
  return digest;
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** `1 h 5 min`, `12 min 3 s` or `45 s`. */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return min > 0 ? `${h} h ${min} min` : `${h} h`;
  if (min > 0) return s > 0 ? `${min} min ${s} s` : `${min} min`;
  return `${s} s`;
}

function displayPath(file, cwd) {
  let shown = file;
  if (cwd !== undefined && isAbsolute(file)) {
    const inside = relative(cwd, file);
    if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
      shown = inside.split(sep).join("/");
    }
  }
  return truncate(shown.replace(/[`\r\n]/g, "_"), LIMITS.path);
}

function code(text) {
  return `\`${text.replace(/[`\r\n]/g, "_")}\``;
}

/** The markdown filed in the knowledge base, already redacted. */
export function renderSummary({ sessionId, cwd, digest }) {
  const facts = [`Session ${code(truncate(sessionId, 120))}`];
  if (digest.durationMs !== undefined) facts.push(formatDuration(digest.durationMs));
  if (digest.messages > 0) {
    facts.push(`${digest.messages} ${digest.messages === 1 ? "message" : "messages"}`);
  }
  const parts = [];
  // The server titles the entry after the first line, so it names what the session was about.
  const headline = (digest.firstPrompt ?? "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^[#>*\-\s]+/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((line) => line !== "");
  if (headline !== undefined) parts.push(`## ${truncate(headline, LIMITS.headline)}`);
  parts.push(facts.join(" · "));
  if (cwd !== undefined) parts.push(`Folder ${code(truncate(cwd, LIMITS.path))}`);

  if (digest.firstPrompt !== undefined) {
    const quoted = truncate(digest.firstPrompt, LIMITS.prompt)
      .split(/\r?\n/)
      .map((line) => (line === "" ? ">" : `> ${line}`))
      .join("\n");
    parts.push(`### Asked\n\n${quoted}`);
  }
  if (digest.lastReply !== undefined) {
    parts.push(`### Outcome\n\n${truncate(digest.lastReply, LIMITS.reply)}`);
  }
  if (digest.editedFiles.length > 0) {
    const files = digest.editedFiles.map((file) => `- ${code(displayPath(file, cwd))}`);
    parts.push(`### Files edited (${digest.editedFiles.length})\n\n${files.join("\n")}`);
  }
  const tools = Object.entries(digest.toolCounts).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  if (tools.length > 0) {
    parts.push(`### Tools\n\n${tools.map(([name, count]) => `${name} ×${count}`).join(" · ")}`);
  }
  if (digest.firstPrompt === undefined && digest.lastReply === undefined) {
    parts.push("No conversation was found in the transcript.");
  }
  return redact(parts.join("\n\n"));
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The MCP endpoint of `base`: `<base>/mcp`, or `base` itself when it already ends in `/mcp`. The
 * token is only ever sent over https, or plain http to this machine.
 */
export function endpointUrl(base) {
  const url = new URL(base);
  if (url.username !== "" || url.password !== "") {
    throw new Error("LOOMCAST_URL must not contain credentials");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("LOOMCAST_URL must use https (plain http only for localhost)");
  }
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`;
  return url;
}

/** The JSON-RPC response with `id` in a JSON body or a server-sent event stream. */
export function parseRpcResponse(contentType, body, id) {
  if (/text\/event-stream/i.test(contentType ?? "")) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data === "") continue;
      try {
        const message = JSON.parse(data);
        if (message?.id === id) return message;
      } catch {
        // Not JSON: keep looking.
      }
    }
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Calls `kb.save_session_summary`. Resolves with `{ok: true, entryId}` or `{ok: false, reason}`
 * (`reason` is `timeout` when the server took longer than `timeoutMs`); never rejects.
 */
export async function postSummary({
  url,
  token,
  args,
  timeoutMs = POST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  const id = 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: TOOL_NAME, arguments: args },
      }),
      redirect: "error",
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    const message = parseRpcResponse(response.headers.get("content-type"), body, id);
    if (message === undefined) {
      return { ok: false, reason: "unreadable response" };
    }
    if (message.error) {
      return { ok: false, reason: String(message.error.message ?? "error") };
    }
    const result = message.result ?? {};
    if (result.isError) {
      const text = Array.isArray(result.content)
        ? result.content.map((part) => part?.text ?? "").join(" ")
        : "";
      return { ok: false, reason: text.trim() || "tool error" };
    }
    const entryId = result.structuredContent?.entryId;
    return { ok: true, entryId: typeof entryId === "string" ? entryId : undefined };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, reason: "timeout" };
    }
    if (!(error instanceof Error)) {
      return { ok: false, reason: "request failed" };
    }
    const cause = error.cause?.code;
    return {
      ok: false,
      reason: typeof cause === "string" ? `${error.message} (${cause})` : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One hook run. Resolves with what happened (`disabled`, `skipped`, `saved` or `failed`) and a
 * detail line; never rejects and never includes the token.
 */
export async function run({
  stdin,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = POST_TIMEOUT_MS,
}) {
  try {
    if (!isEnabled(env)) {
      return { status: "disabled", detail: "set LOOMCAST_SESSION_HOOK=1 to file summaries" };
    }
    const base = String(env.LOOMCAST_URL ?? "").trim();
    const token = String(env.LOOMCAST_MCP_TOKEN ?? "").trim();
    if (base === "" || token === "") {
      return { status: "skipped", detail: "LOOMCAST_URL and LOOMCAST_MCP_TOKEN are required" };
    }
    let url;
    try {
      url = endpointUrl(base);
    } catch (error) {
      return { status: "skipped", detail: error instanceof Error ? error.message : "bad URL" };
    }
    const input = parsePayload(typeof stdin === "string" ? stdin : await readStdin(stdin));
    if (input.sessionId === undefined) {
      return { status: "skipped", detail: "the payload names no session_id" };
    }
    const cwd = input.cwd !== undefined && isAbsolute(input.cwd) ? input.cwd : undefined;
    const workspace = await resolveWorkspace({ cwd, env });
    const digest = await digestTranscript(input.transcriptPath);
    const summaryMd = renderSummary({ sessionId: input.sessionId, cwd, digest });
    const args = {
      sessionId: truncate(input.sessionId, 200),
      summaryMd,
      ...(cwd === undefined ? {} : { cwd: truncate(cwd, 1_024) }),
      ...(workspace === null ? {} : { workspaceId: workspace.workspaceId }),
    };
    const outcome = await postSummary({ url, token, args, timeoutMs, fetchImpl });
    if (!outcome.ok) {
      return { status: "failed", detail: redact(outcome.reason) };
    }
    return { status: "saved", detail: `saved session summary ${outcome.entryId ?? ""}`.trim() };
  } catch (error) {
    return {
      status: "failed",
      detail: redact(error instanceof Error ? error.message : "unexpected error"),
    };
  }
}

async function main() {
  // Whatever happens, the session is never held up or failed by this hook.
  setTimeout(() => process.exit(0), WATCHDOG_MS).unref();
  process.on("uncaughtException", () => process.exit(0));
  process.on("unhandledRejection", () => process.exit(0));
  const outcome = await run({ stdin: process.stdin });
  if (outcome.status !== "disabled") {
    process.stderr.write(`[loomcast hook] ${outcome.status}: ${outcome.detail}\n`);
  }
  process.exit(0);
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch(() => process.exit(0));
}
