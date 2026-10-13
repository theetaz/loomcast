import { spawn } from "node:child_process";
import { e2eSettings, REPO_ROOT } from "./env.ts";

/**
 * Creates the owner account with the admin CLI, exactly as the local development guide does:
 * `pnpm admin:create --email … --name … --role owner --password-stdin`. The API web server has
 * already created and migrated the scratch database.
 */
export default async function globalSetup(): Promise<void> {
  const settings = e2eSettings();
  const args = [
    "admin:create",
    "--email",
    settings.ownerEmail,
    "--name",
    settings.ownerName,
    "--role",
    "owner",
    "--password-stdin",
  ];
  const child = spawn("pnpm", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: settings.databaseUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stdin.end(`${settings.ownerPassword}\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`admin:create exited with ${code}:\n${output}`);
  }
}
