#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TOKEN_FILE } from "./config";
import { main } from "./main";

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readTokenFile(): Promise<string | null> {
  try {
    return await readFile(join(homedir(), TOKEN_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// `pnpm loomcast …` runs this from the package folder; relative paths are read from where the
// command was typed (pnpm passes it as INIT_CWD). A leading `--` from the script is dropped.
const baseDir = process.env.INIT_CWD ?? process.cwd();
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const code = await main(argv, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  readTokenFile,
  readFile: (path) => readFile(resolve(baseDir, path), "utf8"),
  readStdin,
});
process.exitCode = code;
