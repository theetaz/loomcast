import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createDb, type Database } from "@loomcast/db";
import { loadRootEnv } from "../env";
import { systemClock } from "../lib/clock";
import {
  CliError,
  createUser,
  issueToken,
  parseScopes,
  resetPassword,
  validatePassword,
} from "./commands";

const USAGE = `Usage:
  admin create --email <email> --name <name> --role <owner|admin> [--password-stdin]
  admin token --email <email> --name <token name> --scopes <mcp:read,mcp:write,...>
  admin reset-password --email <email> [--password-stdin]

The first account must be the owner. Passwords are typed twice at a hidden prompt; with
--password-stdin, or when stdin is not a terminal, the first line of stdin is used instead.
Reads DATABASE_URL from the environment or the repository's .env.`;

export interface CliInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface CliIo {
  stdin: CliInput;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface CliDatabase {
  db: Database;
  close: () => Promise<void>;
}

/** A malformed command line. Exits with code 2. */
class UsageError extends CliError {}

function usageError(message: string): UsageError {
  return new UsageError(`${message}\n\n${USAGE}`);
}

function required(values: Record<string, unknown>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw usageError(`Missing --${name}.`);
  }
  return value;
}

async function readFirstLine(stdin: CliInput): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

/** Reads a line without echoing it. Backspace edits; Ctrl-C cancels. */
function promptHidden(io: CliIo, question: string): Promise<string> {
  const { stdin } = io;
  io.stderr.write(question);
  stdin.setRawMode?.(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (result: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      io.stderr.write("\n");
      result();
    };
    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          finish(() => resolve(value));
          return;
        }
        if (char === "\u0003") {
          finish(() => reject(new CliError("Cancelled.")));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (char >= " ") {
          value += char;
        }
      }
    };
    stdin.on("data", onData);
  });
}

/** The new password: twice at a hidden prompt, or the first line of stdin. */
async function readNewPassword(io: CliIo, fromStdin: boolean): Promise<string> {
  if (fromStdin || io.stdin.isTTY !== true) {
    return validatePassword(await readFirstLine(io.stdin));
  }
  const password = validatePassword(await promptHidden(io, "New password (12+ characters): "));
  const confirmation = await promptHidden(io, "Repeat the password: ");
  if (password !== confirmation) {
    throw new CliError("The passwords do not match.");
  }
  return password;
}

/**
 * Runs one admin command. Returns the exit code: 0 on success, 1 when the command was refused or
 * failed, 2 for a usage error. `openDb` is called only once the arguments are valid.
 */
export async function runAdmin(
  argv: readonly string[],
  io: CliIo,
  openDb: () => CliDatabase,
): Promise<number> {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const { command, values } = parsed;
  if (command === "help") {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let database: CliDatabase | null = null;
  try {
    const fromStdin = values["password-stdin"] === true;
    if (command === "create") {
      const email = required(values, "email");
      const name = required(values, "name");
      const role = required(values, "role");
      if (role !== "owner" && role !== "admin") {
        throw usageError("--role must be owner or admin.");
      }
      const password = await readNewPassword(io, fromStdin);
      database = openDb();
      const user = await createUser(
        { db: database.db, clock: systemClock },
        { email, name, role, password },
      );
      io.stdout.write(`Created ${user.role} ${user.email} (${user.id}).\n`);
      return 0;
    }
    if (command === "token") {
      const email = required(values, "email");
      const name = required(values, "name");
      const scopes = parseScopes(required(values, "scopes"));
      database = openDb();
      const token = await issueToken(
        { db: database.db, clock: systemClock },
        { email, name, scopes },
      );
      io.stderr.write(
        `Created token ${token.prefix}… with scopes ${token.scopes.join(", ")}.\n` +
          "Copy it now. It is not stored and cannot be shown again:\n",
      );
      io.stdout.write(`${token.secret}\n`);
      return 0;
    }
    const email = required(values, "email");
    const password = await readNewPassword(io, fromStdin);
    database = openDb();
    const { sessionsEnded } = await resetPassword(
      { db: database.db, clock: systemClock },
      { email, password },
    );
    io.stdout.write(`Password reset for ${email}. Ended ${sessionsEnded} session(s).\n`);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr.write(`${error.message}\n`);
      return error instanceof UsageError ? 2 : 1;
    }
    io.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await database?.close();
  }
}

const COMMANDS = ["create", "token", "reset-password", "help"] as const;
type Command = (typeof COMMANDS)[number];

function parseCommandLine(argv: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      email: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      scopes: { type: "string" },
      "password-stdin": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [first, ...rest] = positionals;
  if (values.help === true || first === undefined) {
    return { command: "help" as Command, values };
  }
  if (!(COMMANDS as readonly string[]).includes(first) || rest.length > 0) {
    throw usageError(`Unknown command: ${positionals.join(" ")}`);
  }
  return { command: first as Command, values };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  loadRootEnv();
  runAdmin(process.argv.slice(2), process, () => {
    const url = process.env.DATABASE_URL;
    if (url === undefined || url === "") {
      throw new CliError("DATABASE_URL is not set. Copy .env.example to .env or export it.");
    }
    return createDb(url, { max: 2 });
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
