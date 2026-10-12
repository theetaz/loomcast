import { describe, expect, it } from "vitest";
import { type CliIo, runCli } from "../src/cli";
import { saveConfig } from "../src/config";
import type { AgentPaths } from "../src/paths";
import type { ServiceEnvironment } from "../src/service";
import { TEST_TOKEN, tempAgentPaths, testConfig } from "./helpers";

function captureIo(
  paths: AgentPaths,
  service?: ServiceEnvironment,
): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: { LOOMCAST_AGENT_HOME: paths.home },
    service,
  };
}

describe("studio-agent cli", () => {
  it("status reports an unpaired agent", async () => {
    const io = captureIo(tempAgentPaths());
    expect(await runCli(["status"], io)).toBe(0);
    expect(io.out.join("")).toContain("not paired");
  });

  it("status prints the config with the token redacted", async () => {
    const paths = tempAgentPaths();
    saveConfig(paths, testConfig());
    const io = captureIo(paths);
    expect(await runCli(["status"], io)).toBe(0);
    const output = io.out.join("");
    expect(output).toContain('"token": "lc_dev_[redacted]"');
    expect(output).toContain('"serverUrl": "http://127.0.0.1:8790"');
    expect(output).not.toContain(TEST_TOKEN);
  });

  it("pair requires --server and --code", async () => {
    const io = captureIo(tempAgentPaths());
    expect(await runCli(["pair", "--code", "ABCD-EFGH"], io)).toBe(1);
    expect(io.err.join("")).toContain("Usage: studio-agent pair");
  });

  it("rejects unknown commands and options", async () => {
    const io = captureIo(tempAgentPaths());
    expect(await runCli(["launch"], io)).toBe(1);
    expect(await runCli(["status", "--verbose"], io)).toBe(1);
    expect(io.err.join("")).toContain('Unknown command "launch"');
  });

  it("service install requires a paired agent", async () => {
    const calls: string[][] = [];
    const service: ServiceEnvironment = {
      platform: "darwin",
      homeDir: "/tmp/loomcast-no-home",
      uid: 501,
      nodePath: "/usr/local/bin/node",
      cliPath: "/tmp/cli.mjs",
      exec: async (file, args) => {
        calls.push([file, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const io = captureIo(tempAgentPaths(), service);
    expect(await runCli(["service", "install"], io)).toBe(1);
    expect(io.err.join("")).toContain("Pair this Mac");
    expect(calls).toEqual([]);
  });

  it("service rejects unknown actions", async () => {
    const io = captureIo(tempAgentPaths());
    expect(await runCli(["service", "restart"], io)).toBe(1);
    expect(io.err.join("")).toContain("Usage: studio-agent service");
  });
});
