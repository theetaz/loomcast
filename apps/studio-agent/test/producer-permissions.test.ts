import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpTools } from "@loomcast/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allowedMcpTools,
  deniedMcpTools,
  MCP_TOOL_ALLOW_LIST,
  mcpServersFor,
  normalizeMcpName,
  type ProducerJobType,
  qualifiedToolName,
} from "../src/producer/mcp";
import {
  builtinToolsFor,
  checkToolUse,
  deniedBuiltinTools,
  type McpToolOrigin,
  type ToolGuardOptions,
} from "../src/producer/permissions";
import { testJobToken } from "./helpers";

let base: string;
let workspace: string;
let outside: string;
let agentHome: string;
let guard: ToolGuardOptions;

beforeEach(() => {
  // Not realpath'd on purpose: on macOS the temporary directory is itself behind a symlink.
  base = mkdtempSync(join(tmpdir(), "loomcast-producer-guard-"));
  workspace = join(base, "Loomcast", "projects", "p1");
  outside = join(base, "outside");
  agentHome = join(base, "agent-home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside);
  mkdirSync(agentHome);
  writeFileSync(join(workspace, "script.md"), "draft");
  writeFileSync(join(outside, "secret.txt"), "secret");
  writeFileSync(join(agentHome, "config.json"), "{}");
  guard = { workspaceDir: workspace, protectedDirs: [agentHome] };
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function behavior(tool: string, input: Record<string, unknown>): Promise<string> {
  return (await checkToolUse(guard, tool, input)).behavior;
}

describe("producer tool guard", () => {
  it("denies Bash and every tool outside the allow-list, with a reason", async () => {
    for (const tool of ["Bash", "NotebookEdit", "Agent", "Task", "mcp__server__tool", "Unknown"]) {
      const decision = await checkToolUse(guard, tool, { command: "ls" });
      expect(decision).toMatchObject({ behavior: "deny" });
      expect(decision.behavior === "deny" && decision.message).toContain(tool);
    }
  });

  it("allows reads, searches and web tools", async () => {
    expect(await behavior("Read", { file_path: join(workspace, "script.md") })).toBe("allow");
    expect(await behavior("Read", { file_path: join(outside, "secret.txt") })).toBe("allow");
    expect(await behavior("Glob", { pattern: "**/*.md" })).toBe("allow");
    expect(await behavior("Grep", { pattern: "hook", path: workspace })).toBe("allow");
    expect(await behavior("WebSearch", { query: "short video hooks" })).toBe("allow");
    expect(await behavior("WebFetch", { url: "https://example.com", prompt: "x" })).toBe("allow");
  });

  it("passes the input through unchanged when it allows", async () => {
    const input = { file_path: join(workspace, "new.md"), content: "hello" };
    expect(await checkToolUse(guard, "Write", input)).toEqual({
      behavior: "allow",
      updatedInput: input,
    });
  });

  it("allows writes and edits inside the workspace", async () => {
    expect(await behavior("Write", { file_path: join(workspace, "new.md"), content: "" })).toBe(
      "allow",
    );
    expect(await behavior("Write", { file_path: "relative/dir/new.md", content: "" })).toBe(
      "allow",
    );
    expect(
      await behavior("Edit", {
        file_path: join(workspace, "script.md"),
        old_string: "draft",
        new_string: "final",
      }),
    ).toBe("allow");
  });

  it("rejects writes outside the workspace and paths with ../", async () => {
    const cases = [
      join(outside, "x.md"),
      "../p2/x.md",
      "notes/../../p2/x.md",
      `${workspace}/../p2/x.md`,
      join(workspace, ".."),
      workspace,
      "/etc/hosts",
    ];
    for (const file_path of cases) {
      expect(await behavior("Write", { file_path, content: "" }), file_path).toBe("deny");
      expect(await behavior("Edit", { file_path, old_string: "a", new_string: "b" })).toBe("deny");
    }
  });

  it("rejects a missing or malformed path", async () => {
    expect(await behavior("Write", { content: "" })).toBe("deny");
    expect(await behavior("Write", { file_path: 42 })).toBe("deny");
    expect(await behavior("Edit", { file_path: "" })).toBe("deny");
    expect(await behavior("Write", { file_path: "a\0b" })).toBe("deny");
  });

  it("rejects symlink escapes", async () => {
    symlinkSync(outside, join(workspace, "linked-dir"));
    symlinkSync(join(outside, "secret.txt"), join(workspace, "linked-file.txt"));
    symlinkSync(join(outside, "missing.txt"), join(workspace, "dangling.txt"));

    // A symlinked parent of a new file.
    expect(await behavior("Write", { file_path: join(workspace, "linked-dir", "x.md") })).toBe(
      "deny",
    );
    // A new file deeper below a symlinked directory.
    expect(await behavior("Write", { file_path: "linked-dir/a/b/c.md" })).toBe("deny");
    // A symlinked file.
    expect(
      await behavior("Edit", {
        file_path: join(workspace, "linked-file.txt"),
        old_string: "secret",
        new_string: "x",
      }),
    ).toBe("deny");
    // A dangling symlink whose target would be created outside.
    expect(await behavior("Write", { file_path: join(workspace, "dangling.txt") })).toBe("deny");
  });

  it("allows a symlink that stays inside the workspace", async () => {
    mkdirSync(join(workspace, "drafts"));
    symlinkSync(join(workspace, "drafts"), join(workspace, "current"));
    expect(await behavior("Write", { file_path: join(workspace, "current", "v2.md") })).toBe(
      "allow",
    );
  });

  it("keeps reads and searches out of the agent's private directory", async () => {
    expect(await behavior("Read", { file_path: join(agentHome, "config.json") })).toBe("deny");
    expect(await behavior("Grep", { pattern: "lc_dev_", path: agentHome })).toBe("deny");
    expect(await behavior("Grep", { pattern: "lc_dev_", path: base })).toBe("deny");
    expect(await behavior("Glob", { pattern: "**/*.json", path: base })).toBe("deny");

    symlinkSync(agentHome, join(workspace, "sneaky"));
    expect(await behavior("Read", { file_path: join(workspace, "sneaky", "config.json") })).toBe(
      "deny",
    );
  });
});

const PLATFORM: McpToolOrigin = { name: "loomcast", source: "dynamic" };

async function decide(
  jobType: ProducerJobType,
  tool: string,
  input: Record<string, unknown> = {},
  origin?: McpToolOrigin,
): Promise<string> {
  return (await checkToolUse({ ...guard, jobType }, tool, input, origin)).behavior;
}

describe("platform MCP tool names", () => {
  it("qualifies tool names the way the producer runtime does", () => {
    expect(qualifiedToolName("kb.search")).toBe("mcp__loomcast__kb_search");
    expect(qualifiedToolName("kb.save_brainstorm")).toBe("mcp__loomcast__kb_save_brainstorm");
    expect(qualifiedToolName("project.get")).toBe("mcp__loomcast__project_get");
    expect(normalizeMcpName("a.b c/d-e_f")).toBe("a_b_c_d-e_f");
  });

  it("keeps qualified names unique across the platform's tools", () => {
    const names = Object.keys(mcpTools).map(qualifiedToolName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("allow-lists only tools that job tokens may call, and only reads for analysis", () => {
    for (const [jobType, tools] of Object.entries(MCP_TOOL_ALLOW_LIST)) {
      for (const tool of tools) {
        expect(mcpTools[tool].jobTokens, `${jobType}: ${tool}`).toBe("allow");
      }
    }
    for (const tool of MCP_TOOL_ALLOW_LIST["kb.analyze_reference"]) {
      expect(mcpTools[tool].scope).toBe("mcp:read");
    }
  });

  it("builds the platform server entry with the job token, or none without access", () => {
    const token = testJobToken();
    expect(mcpServersFor(undefined)).toEqual({});
    expect(mcpServersFor({ url: new URL("https://loomcast.example.com/mcp"), token })).toEqual({
      loomcast: {
        type: "http",
        url: "https://loomcast.example.com/mcp",
        headers: { Authorization: `Bearer ${token}` },
        alwaysLoad: true,
      },
    });
  });
});

describe("permission matrix per job type", () => {
  const chatMcp = [
    "kb.search",
    "kb.get",
    "kb.save_brainstorm",
    "kb.add_decision",
    "kb.add_reference",
    "project.get",
  ];
  const analysisMcp = ["kb.search", "kb.get", "project.get"];

  it("allows exactly the allow-listed platform tools for each job type", async () => {
    const matrix: Record<ProducerJobType, readonly string[]> = {
      "producer.chat": chatMcp,
      "kb.analyze_reference": analysisMcp,
    };
    for (const [jobType, allowed] of Object.entries(matrix) as [
      ProducerJobType,
      readonly string[],
    ][]) {
      for (const tool of Object.keys(mcpTools)) {
        const expected = allowed.includes(tool) ? "allow" : "deny";
        expect(
          await decide(jobType, qualifiedToolName(tool), {}, PLATFORM),
          `${jobType} ${tool}`,
        ).toBe(expected);
      }
      expect(allowedMcpTools(jobType)).toEqual(allowed.map(qualifiedToolName));
      expect(deniedMcpTools(jobType)).toHaveLength(Object.keys(mcpTools).length - allowed.length);
    }
  });

  it("denies other MCP servers and unknown MCP tools", async () => {
    for (const jobType of ["producer.chat", "kb.analyze_reference"] as const) {
      expect(await decide(jobType, "mcp__other__kb_search")).toBe("deny");
      expect(
        await decide(jobType, "mcp__loomcast__kb_search", {}, { name: "other", source: "user" }),
      ).toBe("deny");
      expect(await decide(jobType, "mcp__loomcast__shell_exec", {}, PLATFORM)).toBe("deny");
      expect(await decide(jobType, "mcp__loomcast__kb_search", {}, PLATFORM)).toBe("allow");
      expect(await decide(jobType, "mcp__loomcast__kb_search")).toBe("allow");
    }
  });

  it("gives chat every producer tool and analysis only reads", async () => {
    expect(builtinToolsFor("producer.chat")).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "WebSearch",
      "WebFetch",
    ]);
    expect(builtinToolsFor("kb.analyze_reference")).toEqual(["Read", "Glob", "Grep"]);
    expect(deniedBuiltinTools("producer.chat")).toEqual([]);
    expect(deniedBuiltinTools("kb.analyze_reference")).toEqual([
      "Write",
      "Edit",
      "WebSearch",
      "WebFetch",
    ]);

    const inside = join(workspace, "notes.md");
    const writes: [string, Record<string, unknown>][] = [
      ["Write", { file_path: inside, content: "x" }],
      ["Edit", { file_path: join(workspace, "script.md"), old_string: "a", new_string: "b" }],
      ["WebFetch", { url: "https://example.com", prompt: "x" }],
      ["WebSearch", { query: "x" }],
    ];
    for (const [tool, input] of writes) {
      expect(await decide("producer.chat", tool, input), tool).toBe("allow");
      const decision = await checkToolUse(
        { ...guard, jobType: "kb.analyze_reference" },
        tool,
        input,
      );
      expect(decision.behavior, tool).toBe("deny");
      expect(decision.behavior === "deny" && decision.message).toContain("read-only");
    }
    for (const tool of ["Bash", "NotebookEdit", "Task"]) {
      expect(await decide("kb.analyze_reference", tool, { command: "ls" })).toBe("deny");
    }
  });

  it("keeps analysis reads and searches inside the workspace", async () => {
    const analysis = (tool: string, input: Record<string, unknown>) =>
      decide("kb.analyze_reference", tool, input);
    expect(await analysis("Read", { file_path: join(workspace, "script.md") })).toBe("allow");
    expect(await analysis("Read", { file_path: "script.md" })).toBe("allow");
    expect(await analysis("Glob", { pattern: "**/*.md" })).toBe("allow");
    expect(await analysis("Grep", { pattern: "hook" })).toBe("allow");
    expect(await analysis("Grep", { pattern: "hook", path: workspace, glob: "*.txt" })).toBe(
      "allow",
    );

    expect(await analysis("Read", { file_path: join(outside, "secret.txt") })).toBe("deny");
    expect(await analysis("Read", { file_path: "../outside/secret.txt" })).toBe("deny");
    expect(await analysis("Read", {})).toBe("deny");
    expect(await analysis("Glob", { pattern: "**/*", path: base })).toBe("deny");
    expect(await analysis("Glob", { pattern: `${outside}/**` })).toBe("deny");
    expect(await analysis("Glob", { pattern: "../**/*.txt" })).toBe("deny");
    expect(await analysis("Grep", { pattern: "x", path: "/etc" })).toBe("deny");
    expect(await analysis("Grep", { pattern: "x", glob: "../../**" })).toBe("deny");

    symlinkSync(outside, join(workspace, "escape"));
    expect(await analysis("Read", { file_path: join(workspace, "escape", "secret.txt") })).toBe(
      "deny",
    );
    expect(await analysis("Grep", { pattern: "x", path: "escape" })).toBe("deny");
  });
});
