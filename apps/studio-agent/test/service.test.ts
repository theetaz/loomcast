import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPlist,
  type ExecResult,
  installService,
  SERVICE_LABEL,
  type ServiceEnvironment,
  ServiceError,
  servicePaths,
  serviceStatus,
  uninstallService,
} from "../src/service";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FakeLaunchctl {
  readonly calls: string[][];
  results: Partial<Record<string, ExecResult>>;
}

function fakeEnvironment(overrides: Partial<ServiceEnvironment> = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), "loomcast-service-test-"));
  dirs.push(homeDir);
  const cliPath = join(homeDir, "agent", "dist", "cli.mjs");
  mkdirSync(join(homeDir, "agent", "dist"), { recursive: true });
  writeFileSync(cliPath, "");
  const launchctl: FakeLaunchctl = { calls: [], results: {} };
  const env: ServiceEnvironment = {
    platform: "darwin",
    homeDir,
    uid: 501,
    nodePath: "/opt/node/bin/node",
    cliPath,
    exec: async (file, args) => {
      launchctl.calls.push([file, ...args]);
      return launchctl.results[args[0] ?? ""] ?? { code: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  };
  return { env, launchctl, paths: servicePaths(homeDir) };
}

describe("launchd service", () => {
  it("builds a plist that runs the agent with an absolute node path", () => {
    const plist = buildPlist({
      nodePath: "/opt/node/bin/node",
      cliPath: "/Users/me/agent & co/cli.mjs",
      logFile: "/Users/me/Library/Logs/Loomcast/studio-agent.log",
      workingDirectory: "/Users/me",
      environment: { PATH: "/usr/bin:/bin" },
    });
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain(
      "<string>/opt/node/bin/node</string>\n    <string>/Users/me/agent &amp; co/cli.mjs</string>\n    <string>run</string>",
    );
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain(
      "<key>StandardErrorPath</key>\n  <string>/Users/me/Library/Logs/Loomcast/studio-agent.log</string>",
    );
  });

  it("writes the plist and bootstraps it in the gui domain", async () => {
    const { env, launchctl, paths } = fakeEnvironment({ agentHome: "/tmp/agent-home" });
    await installService(env);

    expect(paths.plist).toBe(
      join(env.homeDir, "Library", "LaunchAgents", "com.loomcast.studio-agent.plist"),
    );
    const plist = readFileSync(paths.plist, "utf8");
    expect(plist).toContain(`<string>${env.cliPath}</string>`);
    expect(plist).toContain("<key>LOOMCAST_AGENT_HOME</key>\n    <string>/tmp/agent-home</string>");
    expect(plist).toContain("<string>/opt/node/bin:/opt/homebrew/bin:");
    expect(existsSync(paths.logDir)).toBe(true);
    expect(launchctl.calls).toEqual([
      ["/bin/launchctl", "bootout", "gui/501/com.loomcast.studio-agent"],
      ["/bin/launchctl", "bootstrap", "gui/501", paths.plist],
    ]);
  });

  it("reports a failed bootstrap", async () => {
    const { env, launchctl } = fakeEnvironment();
    launchctl.results.bootstrap = { code: 5, stdout: "", stderr: "Bootstrap failed: 5" };
    await expect(installService(env)).rejects.toThrow(
      "launchctl bootstrap failed: Bootstrap failed: 5",
    );
  });

  it("refuses to install without a built cli or outside macOS", async () => {
    const missing = fakeEnvironment();
    rmSync(missing.env.cliPath);
    await expect(installService(missing.env)).rejects.toThrow(/build the studio agent first/);

    const linux = fakeEnvironment({ platform: "linux" });
    await expect(installService(linux.env)).rejects.toThrow(ServiceError);
    expect(linux.launchctl.calls).toEqual([]);
  });

  it("boots the agent out and removes the plist", async () => {
    const { env, launchctl, paths } = fakeEnvironment();
    await installService(env);
    launchctl.calls.length = 0;

    expect(await uninstallService(env)).toBe(true);
    expect(existsSync(paths.plist)).toBe(false);
    expect(launchctl.calls).toEqual([
      ["/bin/launchctl", "bootout", "gui/501/com.loomcast.studio-agent"],
    ]);
  });

  it("reads the state of a loaded agent", async () => {
    const { env, launchctl } = fakeEnvironment();
    launchctl.results.print = {
      code: 0,
      stdout: [
        "gui/501/com.loomcast.studio-agent = {",
        "\tactive count = 1",
        "\tstate = running",
        "\tpid = 4242",
        "\tlast exit code = (never exited)",
        "\tenvironment = {",
        "\t\tstate = nested",
        "\t}",
        "}",
      ].join("\n"),
      stderr: "",
    };
    expect(await serviceStatus(env)).toMatchObject({
      installed: false,
      loaded: true,
      state: "running",
      pid: 4242,
      lastExitCode: "(never exited)",
    });

    launchctl.results.print = { code: 113, stdout: "", stderr: "Could not find service" };
    expect(await serviceStatus(env)).toMatchObject({ loaded: false });
  });
});
