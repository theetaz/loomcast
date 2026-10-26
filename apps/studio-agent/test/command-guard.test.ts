import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ENV } from "@loomcast/studio/runtime";
import { describe, expect, it } from "vitest";
import { COMMAND_TIMEOUT_MS, checkToolUse } from "../src/producer/permissions";
import { preToolUseGuard } from "../src/producer/sdk-runtime";
import {
  COMMAND_ENV,
  type CommandScope,
  checkCommand,
  shellQuote,
  tokenizeCommand,
} from "../src/production/command-guard";
import { tempDir } from "./production-fakes";

/** A workspace folder with one item, a render folder, a voice take and the pinned CLI. */
function setup() {
  const root = realpathSync(tempDir("loomcast-guard-"));
  const workspace = join(root, "projects", "p1");
  const itemDir = join(workspace, "items", "i1");
  mkdirSync(join(itemDir, "v2", "render"), { recursive: true });
  writeFileSync(join(itemDir, "v2", "voice.mp3"), "voice");
  writeFileSync(join(workspace, "PROJECT.md"), "# workspace");
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.mp3"), "secret");
  const bin = join(root, "studio", "node_modules", "hyperframes", "bin", "hyperframes.mjs");
  mkdirSync(join(bin, ".."), { recursive: true });
  writeFileSync(bin, "// cli");
  const scope: CommandScope = { itemDir, hyperframesBin: bin, nodePath: "/usr/local/bin/node" };
  return { root, workspace, itemDir, outside, bin, scope };
}

const env = Object.entries(COMMAND_ENV)
  .map(([name, value]) => `${name}=${value}`)
  .join(" ");

describe("command tokenizer", () => {
  it.each([
    ["semicolon", "ffprobe -v error a.mp3; rm -rf /"],
    ["and", "npx hyperframes lint render && curl x"],
    ["pipe", "ffprobe -v error a.mp3 | nc host 1"],
    ["substitution", "ffprobe -v error $(cat /etc/passwd)"],
    ["variable", "ffprobe -v error $HOME/a.mp3"],
    ["backtick", "ffprobe -v error `id`"],
    ["redirect out", "npx hyperframes lint render > out.txt"],
    ["redirect in", "ffprobe -v error < a.mp3"],
    ["subshell", "(npx hyperframes lint render)"],
    ["brace", "ffprobe -v error {a,b}.mp3"],
    ["glob star", "ffprobe -v error *.mp3"],
    ["glob question", "ffprobe -v error a?.mp3"],
    ["tilde", "ffprobe -v error ~/a.mp3"],
    ["history", "ffprobe -v error !!"],
    ["newline", "npx hyperframes lint render\nrm -rf /"],
    ["carriage return", "npx hyperframes lint render\rrm"],
    ["single quote", "ffprobe -v error 'a b.mp3'"],
    ["double quote", 'ffprobe -v error "a.mp3"'],
    ["backslash", "ffprobe -v error a\\ b.mp3"],
    ["comment", "npx hyperframes lint render # note"],
  ])("rejects a %s", (_name, command) => {
    expect(Array.isArray(tokenizeCommand(command))).toBe(false);
  });

  it("splits plain commands on spaces and tabs", () => {
    expect(tokenizeCommand("  npx\thyperframes lint  items/i1/v2/render ")).toEqual([
      "npx",
      "hyperframes",
      "lint",
      "items/i1/v2/render",
    ]);
  });

  it("quotes arguments for a POSIX shell", () => {
    expect(shellQuote("/a b/it's")).toBe("'/a b/it'\\''s'");
  });

  it("sets the same telemetry variables as the studio runtime", () => {
    expect(COMMAND_ENV).toEqual(TOOL_ENV);
  });
});

describe("command allow-list", () => {
  it("rewrites lint to the pinned CLI with absolute paths and the telemetry variables", async () => {
    const { workspace, itemDir, bin, scope } = setup();
    const target = join(itemDir, "v2", "render");
    for (const command of [
      "npx hyperframes lint items/i1/v2/render",
      "hyperframes lint items/i1/v2/render --json",
      `npx hyperframes lint ${target}`,
    ]) {
      expect(await checkCommand(command, scope, workspace)).toEqual({
        ok: true,
        kind: "lint",
        target,
        command: `${env} '/usr/local/bin/node' '${bin}' 'lint' '${target}' '--json'`,
      });
    }
  });

  it("rewrites ffprobe with a file: path and keeps allowed options", async () => {
    const { workspace, itemDir, scope } = setup();
    const voice = join(itemDir, "v2", "voice.mp3");
    const decision = await checkCommand(
      "ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 items/i1/v2/voice.mp3",
      scope,
      workspace,
    );
    expect(decision).toEqual({
      ok: true,
      kind: "probe",
      target: voice,
      command: `${env} 'ffprobe' '-v' 'error' '-show_entries' 'format=duration' '-of' 'default=noprint_wrappers=1:nokey=1' 'file:${voice}'`,
    });
  });

  it.each([
    ["render", "npx hyperframes render items/i1/v2/render"],
    ["preview", "npx hyperframes preview items/i1/v2/render"],
    ["init", "npx hyperframes init items/i1/v2"],
    ["skills update", "npx hyperframes skills update"],
    ["other npx package", "npx cowsay hi"],
    ["shell", "sh -c id"],
    ["ffmpeg", "ffmpeg -i items/i1/v2/voice.mp3 out.wav"],
    ["npx ffprobe", "npx ffprobe -v error items/i1/v2/voice.mp3"],
    ["ffprobe without -v error", "ffprobe items/i1/v2/voice.mp3"],
    ["ffprobe output file", "ffprobe -v error -o out.txt items/i1/v2/voice.mp3"],
    ["ffprobe report", "ffprobe -v error -report items/i1/v2/voice.mp3"],
    ["ffprobe bad format", "ffprobe -v error -of xml items/i1/v2/voice.mp3"],
    ["ffprobe two paths", "ffprobe -v error items/i1/v2/voice.mp3 items/i1/v2/voice.mp3"],
    ["lint flag", "npx hyperframes lint items/i1/v2/render --fix"],
    ["lint without path", "npx hyperframes lint"],
    ["parent segments", "npx hyperframes lint items/i1/../i1/v2/render"],
    ["escape with ../", "ffprobe -v error items/i1/v2/../../../../outside/secret.mp3"],
    ["outside the item", "npx hyperframes lint items"],
    ["workspace file", "ffprobe -v error PROJECT.md"],
    ["missing path", "ffprobe -v error items/i1/v2/missing.mp3"],
    ["a url", "ffprobe -v error http://example.com/a.mp3"],
    ["a protocol", "ffprobe -v error concat:items/i1/v2/voice.mp3"],
    ["lint of a file", "npx hyperframes lint items/i1/v2/voice.mp3"],
    ["probe of a folder", "ffprobe -v error items/i1/v2/render"],
    ["empty", ""],
  ])("denies %s with a reason", async (_name, command) => {
    const { workspace, scope } = setup();
    const decision = await checkCommand(command, scope, workspace);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain("Only `npx hyperframes lint <path>`");
    }
  });

  it("denies a symlink that leaves the item directory", async () => {
    const { workspace, itemDir, outside, scope } = setup();
    symlinkSync(join(outside, "secret.mp3"), join(itemDir, "v2", "linked.mp3"));
    symlinkSync(outside, join(itemDir, "v2", "linked-dir"));
    expect(
      (await checkCommand("ffprobe -v error items/i1/v2/linked.mp3", scope, workspace)).ok,
    ).toBe(false);
    expect(
      (await checkCommand("npx hyperframes lint items/i1/v2/linked-dir", scope, workspace)).ok,
    ).toBe(false);
  });

  it("denies lint when the pinned CLI is missing", async () => {
    const { workspace, scope } = setup();
    const decision = await checkCommand(
      "npx hyperframes lint items/i1/v2/render",
      {
        ...scope,
        hyperframesBin: join(scope.itemDir, "missing.mjs"),
      },
      workspace,
    );
    expect(decision).toMatchObject({ ok: false });
  });
});

describe("Bash in producer sessions", () => {
  it("allows the listed commands only in storyboard sessions with a command scope", async () => {
    const { workspace, scope } = setup();
    const input = { command: "npx hyperframes lint items/i1/v2/render", run_in_background: true };
    const storyboard = await checkToolUse(
      { workspaceDir: workspace, jobType: "content.storyboard", commandScope: scope },
      "Bash",
      input,
    );
    expect(storyboard).toMatchObject({ behavior: "allow" });
    if (storyboard.behavior === "allow") {
      // Only the rewritten command and a bounded timeout survive.
      expect(storyboard.updatedInput).toEqual({
        command: expect.stringContaining("'lint'"),
        timeout: COMMAND_TIMEOUT_MS,
      });
    }
    for (const jobType of [
      "producer.chat",
      "kb.analyze_reference",
      "kb.competitor_report",
      "content.write_script",
      "content.revise",
    ] as const) {
      expect(
        await checkToolUse(
          { workspaceDir: workspace, jobType, commandScope: scope },
          "Bash",
          input,
        ),
      ).toMatchObject({ behavior: "deny" });
    }
    expect(
      await checkToolUse({ workspaceDir: workspace, jobType: "content.storyboard" }, "Bash", input),
    ).toMatchObject({ behavior: "deny", message: "Commands are not available in this session." });
  });

  it("denies a render and a substitution in a storyboard session", async () => {
    const { workspace, scope } = setup();
    for (const command of [
      "npx hyperframes render items/i1/v2/render",
      "ffprobe -v error $(id)",
      "npx hyperframes lint items/i1/v2/../../../../outside",
    ]) {
      expect(
        await checkToolUse(
          { workspaceDir: workspace, jobType: "content.storyboard", commandScope: scope },
          "Bash",
          { command },
        ),
      ).toMatchObject({ behavior: "deny" });
    }
  });

  it("enforces the guard in the PreToolUse hook and approves the rewritten command", async () => {
    const { workspace, scope } = setup();
    const hook = preToolUseGuard({
      workspaceDir: workspace,
      jobType: "content.storyboard",
      commandScope: scope,
    });
    const base = { session_id: "s", transcript_path: "/t", cwd: workspace, tool_use_id: "toolu_1" };
    const signal = new AbortController().signal;

    const allowed = await hook(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ffprobe -v error items/i1/v2/voice.mp3" },
      },
      "toolu_1",
      { signal },
    );
    expect(allowed).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: expect.stringContaining("'file:") },
      },
    });

    const denied = await hook(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npx hyperframes render items/i1/v2/render" },
      },
      "toolu_1",
      { signal },
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });

    // Reads outside the workspace are denied by the hook too; allowed reads continue to the
    // normal permission flow.
    const outsideRead = await hook(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/etc/hosts" },
      },
      "toolu_1",
      { signal },
    );
    expect(outsideRead).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const insideRead = await hook(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "PROJECT.md" },
      },
      "toolu_1",
      { signal },
    );
    expect(insideRead).toEqual({ continue: true });
  });
});
