import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkToolUse, type ToolGuardOptions } from "../src/producer/permissions";

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
