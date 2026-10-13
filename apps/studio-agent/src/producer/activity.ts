import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_SUMMARY_LENGTH = 200;

/**
 * A short, redacted description of one tool use for the conversation UI. It names the target
 * (a workspace-relative path, a search pattern, a URL without its query string) and never includes
 * file contents, edit strings or the input of a denied tool.
 */
export function summarizeToolUse(tool: string, input: unknown, cwd: string): string {
  const fields = isRecord(input) ? input : {};
  const text = (key: string): string | undefined => {
    const value = fields[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const where = (key: string): string => {
    const path = text(key);
    return path === undefined ? "" : ` in ${displayPath(path, cwd)}`;
  };

  let summary: string;
  switch (tool) {
    case "Read":
    case "Write":
    case "Edit":
      summary = displayPath(text("file_path") ?? "", cwd);
      break;
    case "Glob":
      summary = `${text("pattern") ?? ""}${where("path")}`;
      break;
    case "Grep":
      summary = `"${text("pattern") ?? ""}"${where("path")}`;
      break;
    case "WebSearch":
      summary = text("query") ?? "";
      break;
    case "WebFetch":
      summary = displayUrl(text("url") ?? "");
      break;
    default:
      summary = "";
  }
  return clean(summary);
}

/** A path relative to the workspace when it is inside it, else with the home directory as `~`. */
function displayPath(path: string, cwd: string): string {
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  if (rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) {
    return rel;
  }
  const home = homedir();
  return absolute === home || absolute.startsWith(`${home}${sep}`)
    ? `~${absolute.slice(home.length)}`
    : absolute;
}

/** The origin and path of a URL; the query string and fragment may carry tokens. */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function clean(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length <= MAX_SUMMARY_LENGTH ? flat : `${flat.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
