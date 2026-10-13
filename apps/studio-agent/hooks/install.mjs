#!/usr/bin/env node
/**
 * Prints the configuration for the Loomcast session-end hook: a hook entry that runs
 * `session-end.mjs` when a session ends, and the environment it reads.
 *
 *   node install.mjs [--url <server>] [--project <project id>]
 *   node install.mjs --write <settings.json> [--url …] [--project …]
 *
 * With `--write`, the hook entry is merged into a JSON settings file of the client: an existing
 * entry for this hook is updated in place, so running it again changes nothing, and the previous
 * file is copied to `<file>.bak` before it is replaced. The environment lines are only printed;
 * the token never goes into a settings file. Plain Node, no dependencies.
 */
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The event the hook runs on, in the common `hooks.<Event>[].hooks[]` settings shape. */
export const HOOK_EVENT = "SessionEnd";
/** Identifies this hook's entry in a settings file. */
export const HOOK_MARKER = "session-end.mjs";
export const HOOK_SCRIPT = fileURLToPath(new URL("./session-end.mjs", import.meta.url));

/** Quotes `value` for a POSIX shell when it needs it. */
export function shellQuote(value) {
  return /^[A-Za-z0-9_/.:=@%+,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command a client runs: this Node binary and the hook script, by absolute path. */
export function hookCommand({ node = process.execPath, script = HOOK_SCRIPT } = {}) {
  return `${shellQuote(node)} ${shellQuote(script)}`;
}

/** The settings fragment that registers `command` for the session-end event. */
export function hookSnippet(command) {
  return { hooks: { [HOOK_EVENT]: [{ hooks: [{ type: "command", command }] }] } };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Adds the hook to a parsed settings object without touching anything else. An entry whose
 * command runs `session-end.mjs` is updated rather than duplicated. Returns a new object and
 * whether it differs.
 */
export function mergeHookConfig(config, command) {
  if (config !== undefined && !isObject(config)) {
    throw new Error("The settings file must hold a JSON object");
  }
  const next = structuredClone(config ?? {});
  if (next.hooks !== undefined && !isObject(next.hooks)) {
    throw new Error('"hooks" in the settings file must be an object');
  }
  next.hooks ??= {};
  const groups = next.hooks[HOOK_EVENT] ?? [];
  if (!Array.isArray(groups)) {
    throw new Error(`"hooks.${HOOK_EVENT}" in the settings file must be an array`);
  }
  next.hooks[HOOK_EVENT] = groups;
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks) {
      if (
        isObject(hook) &&
        typeof hook.command === "string" &&
        hook.command.includes(HOOK_MARKER)
      ) {
        if (hook.command === command && hook.type === "command") {
          return { config: next, changed: false };
        }
        hook.type = "command";
        hook.command = command;
        return { config: next, changed: true };
      }
    }
  }
  groups.push({ hooks: [{ type: "command", command }] });
  return { config: next, changed: true };
}

/**
 * Merges the hook into the JSON file at `file`, creating it when missing. The old file is copied
 * to `<file>.bak` first. Nothing is written when the hook is already there.
 */
export async function installHook(file, command) {
  const path = resolve(file);
  let original;
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let parsed;
  if (original !== undefined && original.trim() !== "") {
    try {
      parsed = JSON.parse(original);
    } catch {
      throw new Error(`${path} is not valid JSON; fix or move it first`);
    }
  }
  const { config, changed } = mergeHookConfig(parsed, command);
  if (!changed) {
    return { path, changed: false, backup: null };
  }
  let backup = null;
  if (original !== undefined) {
    backup = `${path}.bak`;
    await copyFile(path, backup);
  } else {
    await mkdir(dirname(path), { recursive: true });
  }
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return { path, changed: true, backup };
}

/** The environment lines to add where the client starts its hooks. */
export function envLines({ url, project } = {}) {
  return [
    "# Turn the hook on. Without this line it does nothing.",
    "export LOOMCAST_SESSION_HOOK=1",
    "# The Loomcast server (https; plain http only for localhost).",
    `export LOOMCAST_URL=${shellQuote(url ?? "https://loomcast.example.com")}`,
    "# An access token with Write, from Settings > Access tokens. Keep it out of shared files.",
    "export LOOMCAST_MCP_TOKEN=",
    project === undefined
      ? "# Optional: export LOOMCAST_PROJECT_ID=<project id>, or a .loomcast/project.json file"
      : `export LOOMCAST_PROJECT_ID=${shellQuote(project)}`,
  ];
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        write: { type: "string" },
        url: { type: "string" },
        project: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (values.help) {
    process.stdout.write(
      "Usage: install.mjs [--write <settings.json>] [--url <server>] [--project <project id>]\n",
    );
    return;
  }
  const command = hookCommand();
  const env = envLines({ url: values.url, project: values.project }).join("\n");
  if (values.write !== undefined) {
    const result = await installHook(values.write, command);
    process.stdout.write(
      result.changed
        ? `Added the session-end hook to ${result.path}${result.backup ? ` (previous file kept as ${result.backup})` : ""}.\n`
        : `${result.path} already runs the session-end hook; nothing changed.\n`,
    );
  } else {
    process.stdout.write(
      `Add this hook to your client's settings (or run again with --write <file>):\n\n${JSON.stringify(hookSnippet(command), null, 2)}\n`,
    );
  }
  process.stdout.write(
    `\nThen set these in the environment the client runs hooks with:\n\n${env}\n`,
  );
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
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
