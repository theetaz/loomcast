import { type ParseArgsConfig, parseArgs } from "node:util";
import { type Config, ConfigError, resolveConfig, TOKEN_FILE } from "./config";
import {
  createMcpClient,
  type FetchLike,
  McpError,
  needsAdmin,
  resultText,
  type Tool,
  type ToolResult,
} from "./mcp";

/** Everything the CLI touches outside itself, so tests can replace it. */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  /** The token file's contents, or null when it does not exist. */
  readTokenFile(): Promise<string | null>;
  /** A file named by `--args-file`. */
  readFile(path: string): Promise<string>;
  /** Piped standard input, or null when stdin is a terminal. */
  readStdin(): Promise<string | null>;
  fetch?: FetchLike;
  now?(): Date;
}

/** Exit codes: success, a failed call or request, and a usage mistake. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

class UsageError extends Error {
  override readonly name = "UsageError";
}

const USAGE = `Usage: loomcast <command> [options]

Calls the tools of a Loomcast MCP server from a shell.

Commands:
  tools                  List the server's tools with one line each
  describe <tool>        Show a tool's description and input schema
  call <tool>            Call any tool with JSON arguments
  topics                 The research topic leaderboard (research.top_topics)
  videos                 Research videos (research.list_videos)
  accounts               Research accounts (research.list_accounts)
  posts                  Our published posts and their metrics (analytics.list_posts)

Options for every command:
  --url <url>            Server origin (default: LOOMCAST_URL, else ${"https://loomcast.prabhavalabs.com"})
  --admin                Use the owner token (LOOMCAST_MCP_ADMIN_TOKEN) from the start
  --json                 Print JSON instead of text
  -h, --help             Show help; "loomcast <command> --help" for one command

Configuration:
  LOOMCAST_TOKEN         Access token; else LOOMCAST_MCP_TOKEN and LOOMCAST_MCP_ADMIN_TOKEN
                         from ~/${TOKEN_FILE}. A call refused for lacking mcp:admin is
                         retried once with the owner token when there is one.
  LOOMCAST_PROJECT       Default project (id or slug) for topics, videos, accounts and posts
`;

const COMMAND_USAGE: Record<string, string> = {
  tools: `Usage: loomcast tools [--json]

Lists every tool the server offers to your token, with the first sentence of its description.
--json prints the full tool list (names, descriptions and schemas).
`,
  describe: `Usage: loomcast describe <tool> [--json]

Prints the tool's description, the scope it needs, and its input schema as JSON Schema.
--json prints the whole tool entry, output schema included.
`,
  call: `Usage: loomcast call <tool> [--args '<json>' | --args-file <file>] [--json] [--admin]

Calls a tool. Arguments are a JSON object from --args, from --args-file, or piped on stdin;
without any, the tool is called with {}. Prints the tool's text result, or with --json its
structured result. Exits with 1 when the tool reports an error.

Examples:
  loomcast call project.list
  loomcast call research.list_videos --args '{"project":"unfolded","untaggedOnly":true}'
  echo '{"project":"unfolded"}' | loomcast call research.top_topics --json
`,
  topics: `Usage: loomcast topics [--project <id|slug>] [--days <n>] [--min-hits <n>] [--limit <n>] [--json]

The topic leaderboard: tagged research videos of the last --days (default 90) grouped by topic,
best first. --min-hits leaves out topics with fewer creators who had a hit.
`,
  videos: `Usage: loomcast videos [--project <id|slug>] [filters] [--json]

Filters:
  --platform <name>      instagram, tiktok, youtube, facebook or threads
  --handle <handle>      One account
  --topic <topic>        One topic
  --untagged             Only videos without a topic yet
  --min-outlier <n>      Outlier score at least n (5 or more is a hit)
  --min-views <n>        At least n views
  --since <when>         ISO time, or a number of days such as 30d
  --sort <order>         outlier (default), views or recent
  --limit <n>            At most n videos (default 50, at most 200)
  --cursor <cursor>      The next page, from the previous answer
`,
  accounts: `Usage: loomcast accounts [--project <id|slug>] [--platform <name>] [--json]

The accounts in a project's research with followers, median views and video counts.
`,
  posts: `Usage: loomcast posts [--project <id|slug>] [--since <when>] [--limit <n>] [--json]

Our published posts, newest first, with their latest views, reach, likes, comments, shares,
saves and average watch time. --since takes an ISO time or a number of days such as 30d.
`,
};

const GLOBAL_OPTIONS = {
  url: { type: "string" },
  admin: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies NonNullable<ParseArgsConfig["options"]>;

const COMMAND_OPTIONS = {
  tools: {},
  describe: {},
  call: { args: { type: "string" }, "args-file": { type: "string" } },
  topics: {
    project: { type: "string" },
    days: { type: "string" },
    "min-hits": { type: "string" },
    limit: { type: "string" },
  },
  videos: {
    project: { type: "string" },
    platform: { type: "string" },
    handle: { type: "string" },
    topic: { type: "string" },
    untagged: { type: "boolean" },
    "min-outlier": { type: "string" },
    "min-views": { type: "string" },
    since: { type: "string" },
    sort: { type: "string" },
    limit: { type: "string" },
    cursor: { type: "string" },
  },
  accounts: { project: { type: "string" }, platform: { type: "string" } },
  posts: { project: { type: "string" }, since: { type: "string" }, limit: { type: "string" } },
} as const satisfies Record<string, NonNullable<ParseArgsConfig["options"]>>;

type Command = keyof typeof COMMAND_OPTIONS;

function isCommand(value: string): value is Command {
  return Object.hasOwn(COMMAND_OPTIONS, value);
}

export interface ParsedArgs {
  command: Command | null;
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
}

/** Every option of every command, so options may come before the command name. */
const ALL_OPTIONS: NonNullable<ParseArgsConfig["options"]> = Object.assign(
  {},
  GLOBAL_OPTIONS,
  ...Object.values(COMMAND_OPTIONS),
);

/** Splits the command line into the command, its positionals and its options. */
export function parseCommandLine(argv: readonly string[]): ParsedArgs {
  let values: ParsedArgs["values"];
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: ALL_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as ParsedArgs["values"];
    positionals = parsed.positionals;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const [name, ...rest] = positionals;
  if (name !== undefined && !isCommand(name)) {
    throw new UsageError(`Unknown command "${name}". Run "loomcast --help".`);
  }
  const command = name ?? null;
  const allowed = { ...GLOBAL_OPTIONS, ...(command === null ? {} : COMMAND_OPTIONS[command]) };
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(allowed, key)) {
      throw new UsageError(
        command === null
          ? `--${key} needs a command. Run "loomcast --help".`
          : `--${key} does not apply to "${command}". Run "loomcast ${command} --help".`,
      );
    }
  }
  return { command, positionals: rest, values };
}

function stringOption(values: ParsedArgs["values"], name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

function integerOption(values: ParsedArgs["values"], name: string): number | undefined {
  const raw = stringOption(values, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} takes a whole number (got "${raw}").`);
  return Number(raw);
}

function numberOption(values: ParsedArgs["values"], name: string): number | undefined {
  const raw = stringOption(values, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0) {
    throw new UsageError(`--${name} takes a number (got "${raw}").`);
  }
  return value;
}

/** `--since`: an ISO time, or `<n>d` for n days before now. */
export function sinceOption(raw: string | undefined, now: Date): string | undefined {
  if (raw === undefined) return undefined;
  const days = /^(\d+)d$/.exec(raw);
  if (days?.[1] !== undefined) {
    return new Date(now.getTime() - Number(days[1]) * 24 * 60 * 60_000).toISOString();
  }
  const time = new Date(raw);
  if (Number.isNaN(time.getTime())) {
    throw new UsageError(
      `--since takes an ISO time or a number of days such as 30d (got "${raw}").`,
    );
  }
  return time.toISOString();
}

/** Leaves out undefined values, so tools see only the arguments given. */
function defined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function parseJsonArgs(text: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`The arguments from ${source} are not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`The arguments from ${source} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** The first sentence of a description, on one line, at most 100 characters. */
export function oneLine(description: string | undefined): string {
  const flat = (description ?? "").replace(/\s+/g, " ").trim();
  const sentence = /^(.+?\.)(?:\s|$)/.exec(flat)?.[1] ?? flat;
  // "Owner only." alone says little: keep the sentence after it too.
  const text =
    sentence === "Owner only."
      ? (/^(Owner only\. .+?\.)(?:\s|$)/.exec(flat)?.[1] ?? flat)
      : sentence;
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

function formatTools(tools: readonly Tool[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const width = Math.max(0, ...sorted.map((tool) => tool.name.length));
  return sorted
    .map((tool) => `${tool.name.padEnd(width)}  ${oneLine(tool.description)}`)
    .join("\n");
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Runs one command line and returns the exit code. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return EXIT.usage;
  }
  const { command, positionals, values } = parsed;
  if (command === null) {
    if (values.help === true || argv.length === 0) {
      io.stdout(USAGE);
      return argv.length === 0 ? EXIT.usage : EXIT.ok;
    }
    io.stderr(`Name a command. Run "loomcast --help".\n`);
    return EXIT.usage;
  }
  if (values.help === true) {
    io.stdout(COMMAND_USAGE[command] ?? USAGE);
    return EXIT.ok;
  }

  try {
    const config = resolveConfig({
      env: io.env,
      file: await io.readTokenFile(),
      url: stringOption(values, "url"),
      admin: values.admin === true,
    });
    return await run(command, positionals, values, config, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n`);
      return EXIT.usage;
    }
    if (error instanceof ConfigError || error instanceof McpError) {
      io.stderr(`${error.message}\n`);
      return EXIT.failed;
    }
    throw error;
  }
}

async function run(
  command: Command,
  positionals: string[],
  values: ParsedArgs["values"],
  config: Config,
  io: CliIo,
): Promise<number> {
  const client = createMcpClient({ url: config.url, token: config.token, fetch: io.fetch });
  const asJson = values.json === true;
  const now = io.now?.() ?? new Date();

  const project = (): string => {
    const value = stringOption(values, "project") ?? config.project;
    if (value === null || value === undefined) {
      throw new UsageError("Name the project with --project <id|slug>, or set LOOMCAST_PROJECT.");
    }
    return value;
  };

  /** Calls a tool, once more with the owner token when it needs `mcp:admin`. */
  const callTool = async (name: string, args: Record<string, unknown>): Promise<number> => {
    let result: ToolResult = await client.callTool(name, args);
    if (needsAdmin(result) && config.adminToken !== null) {
      const admin = createMcpClient({ url: config.url, token: config.adminToken, fetch: io.fetch });
      result = await admin.callTool(name, args);
    }
    if (asJson) {
      const output =
        result.isError === true
          ? { isError: true, text: resultText(result) }
          : (result.structuredContent ?? result);
      io.stdout(`${json(output)}\n`);
    } else {
      const text = resultText(result);
      (result.isError === true ? io.stderr : io.stdout)(`${text === "" ? json(result) : text}\n`);
    }
    return result.isError === true ? EXIT.failed : EXIT.ok;
  };

  switch (command) {
    case "tools": {
      const tools = await client.listTools();
      io.stdout(`${asJson ? json(tools) : formatTools(tools)}\n`);
      return EXIT.ok;
    }
    case "describe": {
      const [name] = positionals;
      if (name === undefined) throw new UsageError("Usage: loomcast describe <tool>");
      const tool = (await client.listTools()).find((candidate) => candidate.name === name);
      if (tool === undefined) {
        io.stderr(`No tool is called "${name}". Run "loomcast tools".\n`);
        return EXIT.failed;
      }
      if (asJson) {
        io.stdout(`${json(tool)}\n`);
      } else {
        const readOnly = tool.annotations?.readOnlyHint === true ? " (read-only)" : "";
        io.stdout(
          `${tool.name}${readOnly}\n\n${tool.description ?? ""}\n\nInput schema:\n${json(
            tool.inputSchema ?? {},
          )}\n`,
        );
      }
      return EXIT.ok;
    }
    case "call": {
      const [name, ...extra] = positionals;
      if (name === undefined) throw new UsageError("Usage: loomcast call <tool> [--args '<json>']");
      if (extra.length > 0) {
        throw new UsageError(`Unexpected "${extra.join(" ")}": pass arguments with --args.`);
      }
      const inline = stringOption(values, "args");
      const file = stringOption(values, "args-file");
      if (inline !== undefined && file !== undefined) {
        throw new UsageError("Give --args or --args-file, not both.");
      }
      let args: Record<string, unknown> = {};
      if (inline !== undefined) {
        args = parseJsonArgs(inline, "--args");
      } else if (file !== undefined) {
        args = parseJsonArgs(await io.readFile(file), file);
      } else {
        const piped = await io.readStdin();
        if (piped !== null && piped.trim() !== "") args = parseJsonArgs(piped, "stdin");
      }
      return callTool(name, args);
    }
    case "topics":
      return callTool(
        "research.top_topics",
        defined({
          project: project(),
          windowDays: integerOption(values, "days"),
          minHitCreators: integerOption(values, "min-hits"),
          limit: integerOption(values, "limit"),
        }),
      );
    case "videos":
      return callTool(
        "research.list_videos",
        defined({
          project: project(),
          platform: stringOption(values, "platform"),
          handle: stringOption(values, "handle"),
          topic: stringOption(values, "topic"),
          untaggedOnly: values.untagged === true ? true : undefined,
          minOutlier: numberOption(values, "min-outlier"),
          minViews: integerOption(values, "min-views"),
          since: sinceOption(stringOption(values, "since"), now),
          sort: stringOption(values, "sort"),
          limit: integerOption(values, "limit"),
          cursor: stringOption(values, "cursor"),
        }),
      );
    case "accounts":
      return callTool(
        "research.list_accounts",
        defined({ project: project(), platform: stringOption(values, "platform") }),
      );
    case "posts":
      return callTool(
        "analytics.list_posts",
        defined({
          project: stringOption(values, "project") ?? config.project ?? undefined,
          since: sinceOption(stringOption(values, "since"), now),
          limit: integerOption(values, "limit"),
        }),
      );
  }
}
