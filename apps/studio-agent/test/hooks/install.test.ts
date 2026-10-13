import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  envLines,
  HOOK_SCRIPT,
  hookCommand,
  hookSnippet,
  installHook,
  mergeHookConfig,
  shellQuote,
} from "../../hooks/install.mjs";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loomcast-hook-install-"));
  dirs.push(dir);
  return dir;
}

const command = "/usr/local/bin/node /opt/loomcast/hooks/session-end.mjs";

describe("hook installer", () => {
  it("builds a command from absolute paths, quoting when needed", () => {
    expect(HOOK_SCRIPT).toMatch(/hooks[/\\]session-end\.mjs$/);
    expect(hookCommand({ node: "/usr/bin/node", script: "/a b/session-end.mjs" })).toBe(
      "/usr/bin/node '/a b/session-end.mjs'",
    );
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(hookSnippet(command)).toEqual({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command }] }] },
    });
  });

  it("merges into existing settings without touching other keys", () => {
    const existing = {
      theme: "dark",
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "echo bye" }] }],
      },
    };
    const { config, changed } = mergeHookConfig(existing, command);
    expect(changed).toBe(true);
    expect(config).toEqual({
      theme: "dark",
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }],
        SessionEnd: [
          { hooks: [{ type: "command", command: "echo bye" }] },
          { hooks: [{ type: "command", command }] },
        ],
      },
    });
    // The input is not modified.
    expect(existing.hooks.SessionEnd).toHaveLength(1);

    expect(mergeHookConfig(config, command)).toEqual({ config, changed: false });

    const moved = mergeHookConfig(config, "/other/node /new/place/session-end.mjs");
    expect(moved.changed).toBe(true);
    expect(moved.config.hooks?.SessionEnd).toEqual([
      { hooks: [{ type: "command", command: "echo bye" }] },
      { hooks: [{ type: "command", command: "/other/node /new/place/session-end.mjs" }] },
    ]);
  });

  it("refuses settings it cannot merge into", () => {
    expect(() => mergeHookConfig([], command)).toThrow(/JSON object/);
    expect(() => mergeHookConfig({ hooks: [] }, command)).toThrow(/"hooks"/);
    expect(() => mergeHookConfig({ hooks: { SessionEnd: {} } }, command)).toThrow(/array/);
  });

  it("writes a backup first and is idempotent", async () => {
    const dir = tempDir();
    const file = join(dir, "settings.json");
    const original = `${JSON.stringify({ model: "x" }, null, 2)}\n`;
    writeFileSync(file, original);

    const first = await installHook(file, command);
    expect(first).toEqual({ path: file, changed: true, backup: `${file}.bak` });
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(original);
    const written = readFileSync(file, "utf8");
    expect(JSON.parse(written)).toEqual({ model: "x", ...hookSnippet(command) });

    const second = await installHook(file, command);
    expect(second).toEqual({ path: file, changed: false, backup: null });
    expect(readFileSync(file, "utf8")).toBe(written);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(original);
  });

  it("creates a missing file and rejects invalid JSON", async () => {
    const dir = tempDir();
    const file = join(dir, "nested", "settings.json");
    expect(await installHook(file, command)).toEqual({ path: file, changed: true, backup: null });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(hookSnippet(command));

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{");
    await expect(installHook(broken, command)).rejects.toThrow(/not valid JSON/);
  });

  it("prints environment lines with no token value", () => {
    const lines = envLines({ url: "http://localhost:5173" });
    expect(lines).toContain("export LOOMCAST_SESSION_HOOK=1");
    expect(lines).toContain("export LOOMCAST_URL=http://localhost:5173");
    expect(lines).toContain("export LOOMCAST_MCP_TOKEN=");
    expect(envLines({ project: "p-1" })).toContain("export LOOMCAST_PROJECT_ID=p-1");
  });
});
