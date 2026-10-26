import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestTranscript,
  endpointUrl,
  formatDuration,
  isEnabled,
  LIMITS,
  parsePayload,
  parseRpcResponse,
  postSummary,
  REDACTED,
  REDACTED_LINE,
  readStdin,
  redact,
  renderSummary,
  resolveWorkspace,
  run,
  TOOL_NAME,
} from "../../hooks/session-end.mjs";

const HOOK = fileURLToPath(new URL("../../hooks/session-end.mjs", import.meta.url));

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loomcast-hook-test-"));
  dirs.push(dir);
  return dir;
}

/** Random letters and digits, so no secret-shaped literal appears in this file. */
function randomAlnum(
  length: number,
  alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789",
) {
  return [...randomBytes(length)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** Secret-shaped samples, assembled at run time. */
function samples() {
  return {
    loomcast: ["lc", "mcp", randomAlnum(40)].join("_"),
    vendorKey: ["sk", "proj", randomAlnum(32)].join("-"),
    cloudKey: ["AK", "IA", randomAlnum(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")].join(""),
    gitToken: ["gh", "p_", randomAlnum(36)].join(""),
    passwordLine: ["db_pass", "word", "=", randomAlnum(14)].join(""),
  };
}

function writeTranscript(dir: string, records: unknown[]): string {
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return path;
}

const t0 = Date.parse("2026-10-13T09:00:00.000Z");
const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();

function sampleRecords(cwd: string) {
  return [
    { type: "summary", summary: "ignored" },
    {
      type: "user",
      isMeta: true,
      timestamp: at(0),
      message: { role: "user", content: "<context>injected</context>" },
    },
    {
      type: "user",
      timestamp: at(1),
      message: { role: "user", content: "<command-name>/clear</command-name>" },
    },
    {
      type: "user",
      timestamp: at(2),
      message: { role: "user", content: "Write a hook about how DNS resolves a name." },
    },
    "not json at all",
    {
      type: "assistant",
      timestamp: at(30),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Reading the script first." },
          { type: "tool_use", name: "Read", input: { file_path: join(cwd, "script.md") } },
          { type: "tool_use", name: "Edit", input: { file_path: join(cwd, "script.md") } },
          { type: "tool_use", name: "Write", input: { file_path: join(cwd, "hooks", "dns.md") } },
          {
            type: "tool_use",
            name: "NotebookEdit",
            input: { notebook_path: "/elsewhere/n.ipynb" },
          },
        ],
      },
    },
    {
      type: "user",
      timestamp: at(31),
      message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
    },
    {
      type: "assistant",
      isSidechain: true,
      timestamp: at(40),
      message: { role: "assistant", content: [{ type: "text", text: "A side conversation." }] },
    },
    {
      type: "assistant",
      timestamp: at(125),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Done: the hook opens on a lookup that fails." },
          { type: "tool_use", name: "Edit", input: { file_path: join(cwd, "script.md") } },
        ],
      },
    },
  ];
}

describe("digest", () => {
  it("takes the first real prompt, the last reply, edited files, tool counts and duration", async () => {
    const dir = tempDir();
    const cwd = join(dir, "workspace");
    const path = writeTranscript(dir, sampleRecords(cwd));

    const digest = await digestTranscript(path);

    expect(digest.firstPrompt).toBe("Write a hook about how DNS resolves a name.");
    expect(digest.lastReply).toBe("Done: the hook opens on a lookup that fails.");
    expect(digest.editedFiles).toEqual([
      join(cwd, "script.md"),
      join(cwd, "hooks", "dns.md"),
      "/elsewhere/n.ipynb",
    ]);
    expect(digest.toolCounts).toEqual({ Read: 1, Edit: 2, Write: 1, NotebookEdit: 1 });
    expect(digest.durationMs).toBe(125_000);
  });

  it("renders bounded markdown with paths relative to the working directory", async () => {
    const dir = tempDir();
    const cwd = join(dir, "workspace");
    const records = sampleRecords(cwd);
    records.push({
      type: "user",
      timestamp: at(130),
      message: { role: "user", content: "x".repeat(10) },
    });
    records.splice(3, 1, {
      type: "user",
      timestamp: at(2),
      message: { role: "user", content: "p".repeat(2_000) },
    });
    records.push({
      type: "assistant",
      timestamp: at(140),
      message: { role: "assistant", content: "r".repeat(10_000) },
    });
    const digest = await digestTranscript(writeTranscript(dir, records));
    const summary = renderSummary({ sessionId: "session-1", cwd, digest });

    expect(
      summary.startsWith(
        `## ${"p".repeat(LIMITS.headline - 1)}…\n\nSession \`session-1\` · 2 min 20 s`,
      ),
    ).toBe(true);
    expect(summary).toContain(`Folder \`${cwd}\``);
    expect(summary).toContain("- `script.md`");
    expect(summary).toContain("- `hooks/dns.md`");
    expect(summary).toContain("- `/elsewhere/n.ipynb`");
    expect(summary).toContain("Edit ×2 · NotebookEdit ×1 · Read ×1 · Write ×1");
    const asked = /### Asked\n\n> (p+…)/.exec(summary)?.[1] ?? "";
    expect(asked).toHaveLength(LIMITS.prompt);
    const outcome = /### Outcome\n\n(r+…)/.exec(summary)?.[1] ?? "";
    expect(outcome).toHaveLength(LIMITS.reply);
  });

  it("lists at most 50 edited files", async () => {
    const dir = tempDir();
    const records = Array.from({ length: 80 }, (_, index) => ({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Write", input: { file_path: `/w/file-${index}.md` } }],
      },
    }));
    const digest = await digestTranscript(writeTranscript(dir, records));
    expect(digest.editedFiles).toHaveLength(LIMITS.files);
    expect(digest.toolCounts).toEqual({ Write: 80 });
  });

  it("gives an empty digest for a missing, relative or unreadable transcript", async () => {
    const dir = tempDir();
    for (const path of [undefined, "relative.jsonl", join(dir, "missing.jsonl"), dir]) {
      const digest = await digestTranscript(path);
      expect(digest).toMatchObject({ firstPrompt: undefined, lastReply: undefined, messages: 0 });
    }
    const summary = renderSummary({
      sessionId: "s",
      cwd: undefined,
      digest: await digestTranscript(undefined),
    });
    expect(summary).toContain("No conversation was found in the transcript.");
  });

  it("formats durations", () => {
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(12 * 60_000)).toBe("12 min");
    expect(formatDuration(65 * 60_000)).toBe("1 h 5 min");
  });
});

describe("redaction", () => {
  it("removes tokens and keys, and drops password lines", () => {
    const s = samples();
    const text = [
      `Connect with ${s.loomcast} please`,
      `export KEY=${s.vendorKey}`,
      `id ${s.cloudKey} in the config`,
      `push with ${s.gitToken}`,
      s.passwordLine,
      `Authorization: Bearer ${randomAlnum(32)}`,
      "Nothing secret here.",
    ].join("\n");

    const out = redact(text);

    for (const secret of Object.values(s)) {
      expect(out).not.toContain(secret);
    }
    expect(out).toBe(
      [
        `Connect with ${REDACTED} please`,
        `export KEY=${REDACTED}`,
        `id ${REDACTED} in the config`,
        `push with ${REDACTED}`,
        REDACTED_LINE,
        `Authorization: Bearer ${REDACTED}`,
        "Nothing secret here.",
      ].join("\n"),
    );
  });

  it("redacts the prompt, the reply and file paths of the summary", async () => {
    const s = samples();
    const dir = tempDir();
    const path = writeTranscript(dir, [
      { type: "user", message: { role: "user", content: `Use ${s.loomcast} for the server` } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `Set it:\n${s.passwordLine}\nand ${s.vendorKey}` },
            { type: "tool_use", name: "Write", input: { file_path: `/tmp/${s.gitToken}.txt` } },
          ],
        },
      },
    ]);
    const summary = renderSummary({
      sessionId: "s",
      cwd: undefined,
      digest: await digestTranscript(path),
    });
    for (const secret of Object.values(s)) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).toContain(REDACTED_LINE);
  });
});

describe("workspace resolution", () => {
  const id = "0b6c2f7e-8d4a-4c1e-9f3b-2a1d4e5f6a70";
  const other = "2d8e4b9a-af6c-4e3a-9b5d-4c3f6a7b8c92";

  it("prefers LOOMCAST_WORKSPACE_ID and ignores an invalid one", async () => {
    expect(
      await resolveWorkspace({ cwd: "/", env: { LOOMCAST_WORKSPACE_ID: id.toUpperCase() } }),
    ).toEqual({
      workspaceId: id,
      source: "env",
    });
    expect(await resolveWorkspace({ cwd: "/", env: { LOOMCAST_WORKSPACE_ID: "nope" } })).toBeNull();
  });

  it("finds the nearest .loomcast/workspace.json above the working directory", async () => {
    const root = tempDir();
    mkdirSync(join(root, ".loomcast"));
    writeFileSync(
      join(root, ".loomcast", "workspace.json"),
      JSON.stringify({ workspaceId: other }),
    );
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(await resolveWorkspace({ cwd: nested, env: {} })).toEqual({
      workspaceId: other,
      source: join(root, ".loomcast", "workspace.json"),
    });

    mkdirSync(join(root, "a", ".loomcast"));
    writeFileSync(
      join(root, "a", ".loomcast", "workspace.json"),
      JSON.stringify({ workspaceId: id }),
    );
    expect((await resolveWorkspace({ cwd: nested, env: {} }))?.workspaceId).toBe(id);
  });

  it("returns null when the nearest file is unusable or there is none", async () => {
    const root = tempDir();
    mkdirSync(join(root, ".loomcast"));
    writeFileSync(join(root, ".loomcast", "workspace.json"), "{not json");
    expect(await resolveWorkspace({ cwd: root, env: {} })).toBeNull();
    writeFileSync(join(root, ".loomcast", "workspace.json"), JSON.stringify({ workspaceId: 42 }));
    expect(await resolveWorkspace({ cwd: root, env: {} })).toBeNull();
    expect(await resolveWorkspace({ cwd: undefined, env: {} })).toBeNull();
    expect(await resolveWorkspace({ cwd: "relative/dir", env: {} })).toBeNull();
  });
});

describe("configuration", () => {
  it("is off unless LOOMCAST_SESSION_HOOK is set", () => {
    expect(isEnabled({})).toBe(false);
    expect(isEnabled({ LOOMCAST_SESSION_HOOK: "0" })).toBe(false);
    for (const value of ["1", "true", "ON", " yes "]) {
      expect(isEnabled({ LOOMCAST_SESSION_HOOK: value })).toBe(true);
    }
  });

  it("builds the endpoint and refuses plain http beyond this machine", () => {
    expect(endpointUrl("https://loomcast.example.com").href).toBe(
      "https://loomcast.example.com/mcp",
    );
    expect(endpointUrl("https://example.com/loomcast/").href).toBe(
      "https://example.com/loomcast/mcp",
    );
    expect(endpointUrl("http://localhost:5173/mcp").href).toBe("http://localhost:5173/mcp");
    expect(endpointUrl("http://127.0.0.1:8790").href).toBe("http://127.0.0.1:8790/mcp");
    expect(() => endpointUrl("http://loomcast.example.com")).toThrow(/https/);
    expect(() => endpointUrl(`https://user:${randomAlnum(8)}@example.com`)).toThrow(/credentials/);
  });

  it("reads the payload fields and tolerates anything else", () => {
    expect(parsePayload('{"session_id":"s","transcript_path":"/t.jsonl","cwd":"/w"}')).toEqual({
      sessionId: "s",
      transcriptPath: "/t.jsonl",
      cwd: "/w",
    });
    expect(parsePayload("{}")).toEqual({
      sessionId: undefined,
      transcriptPath: undefined,
      cwd: undefined,
    });
    expect(parsePayload("[]")).toEqual({});
    expect(parsePayload("not json")).toEqual({});
  });

  it("stops reading stdin at the limit or after the timeout", async () => {
    expect(await readStdin(Readable.from(["ab", "cd"]))).toBe("abcd");
    expect(await readStdin(Readable.from(["abcdef"]), { limit: 3 })).toBe("abc");
    const silent = new Readable({ read() {} });
    const started = Date.now();
    expect(await readStdin(silent, { timeoutMs: 50 })).toBe("");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

async function mcpServer(handler: Handler): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => handler(request, body, response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function rpcResult(entryId: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: `Saved session summary ${entryId}.` }],
      structuredContent: { entryId },
    },
  };
}

describe("posting", () => {
  it("calls kb.save_session_summary with the digest and reads a JSON answer", async () => {
    const token = ["lc", "mcp", randomAlnum(40)].join("_");
    const entryId = randomUUID();
    const workspaceId = randomUUID();
    let seen: { headers: IncomingMessage["headers"]; body: Record<string, unknown> } | undefined;
    const base = await mcpServer((request, body, response) => {
      seen = { headers: request.headers, body: JSON.parse(body) };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(rpcResult(entryId)));
    });
    const dir = tempDir();
    const cwd = join(dir, "workspace");
    const transcriptPath = writeTranscript(dir, sampleRecords(cwd));

    const outcome = await run({
      stdin: JSON.stringify({ session_id: "s-1", transcript_path: transcriptPath, cwd }),
      env: {
        LOOMCAST_SESSION_HOOK: "1",
        LOOMCAST_URL: base,
        LOOMCAST_MCP_TOKEN: token,
        LOOMCAST_WORKSPACE_ID: workspaceId,
      },
    });

    expect(outcome).toEqual({ status: "saved", detail: `saved session summary ${entryId}` });
    expect(seen?.headers.authorization).toBe(`Bearer ${token}`);
    expect(seen?.headers.accept).toBe("application/json, text/event-stream");
    expect(seen?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: TOOL_NAME, arguments: { sessionId: "s-1", cwd, workspaceId } },
    });
    if (seen === undefined) throw new Error("the server saw no request");
    const args = (seen.body.params as { arguments: { summaryMd: string } }).arguments;
    expect(args.summaryMd).toContain("Write a hook about how DNS resolves a name.");
    expect(JSON.stringify(outcome)).not.toContain(token);
  });

  it("reads an event-stream answer and reports tool errors", async () => {
    const entryId = randomUUID();
    const base = await mcpServer((_request, body, response) => {
      const args = JSON.parse(body).params.arguments as { sessionId: string };
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (args.sessionId === "fails") {
        response.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              isError: true,
              content: [{ type: "text", text: "workspace_unresolved: Name the workspace." }],
            },
          })}\n\n`,
        );
        return;
      }
      response.end(`: comment\n\nevent: message\ndata: ${JSON.stringify(rpcResult(entryId))}\n\n`);
    });
    const env = {
      LOOMCAST_SESSION_HOOK: "1",
      LOOMCAST_URL: base,
      LOOMCAST_MCP_TOKEN: randomAlnum(20),
    };

    expect(await run({ stdin: '{"session_id":"ok"}', env })).toEqual({
      status: "saved",
      detail: `saved session summary ${entryId}`,
    });
    expect(await run({ stdin: '{"session_id":"fails"}', env })).toEqual({
      status: "failed",
      detail: "workspace_unresolved: Name the workspace.",
    });
  });

  it("parses JSON-RPC answers", () => {
    expect(parseRpcResponse("application/json", '{"id":1}', 1)).toEqual({ id: 1 });
    expect(parseRpcResponse("application/json", "nope", 1)).toBeUndefined();
    expect(
      parseRpcResponse("text/event-stream", 'data: {"id":2}\n\ndata: {"id":1}\n\n', 1),
    ).toEqual({
      id: 1,
    });
    expect(parseRpcResponse("text/event-stream", "data: nope\n\n", 1)).toBeUndefined();
  });

  it("reports HTTP errors without throwing", async () => {
    const base = await mcpServer((_request, _body, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}');
    });
    const outcome = await postSummary({ url: `${base}/mcp`, token: "t", args: {} });
    expect(outcome).toEqual({ ok: false, reason: "HTTP 401" });
  });
});

describe("timeout", () => {
  it("gives up on a server that never answers", async () => {
    const base = await mcpServer(() => {
      // Never answers.
    });
    const started = Date.now();
    const outcome = await postSummary({ url: `${base}/mcp`, token: "t", args: {}, timeoutMs: 150 });
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("exits 0 within the 5 s limit when the server hangs, and when switched off", async () => {
    const base = await mcpServer(() => {
      // Never answers.
    });
    const exec = (input: string, env: Record<string, string>) =>
      new Promise<{ code: number | null; stderr: string; ms: number }>((resolve, reject) => {
        const started = Date.now();
        const child = spawn(process.execPath, [HOOK], {
          env: { PATH: process.env.PATH ?? "", ...env },
          stdio: ["pipe", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stderr, ms: Date.now() - started }));
        child.stdin.end(input);
      });

    const off = await exec("{}", {});
    expect(off).toMatchObject({ code: 0, stderr: "" });

    const garbage = await exec("garbage", { LOOMCAST_SESSION_HOOK: "1" });
    expect(garbage.code).toBe(0);

    const token = randomAlnum(24);
    const hung = await exec('{"session_id":"s"}', {
      LOOMCAST_SESSION_HOOK: "1",
      LOOMCAST_URL: base,
      LOOMCAST_MCP_TOKEN: token,
    });
    expect(hung.code).toBe(0);
    expect(hung.stderr).toContain("failed: timeout");
    expect(hung.stderr).not.toContain(token);
    expect(hung.ms).toBeLessThan(9_000);
  }, 20_000);
});
