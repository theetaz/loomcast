import { readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  configIsShared,
  loadConfig,
  REDACTED_TOKEN,
  redactConfig,
  saveConfig,
} from "../src/config";
import { resolveAgentPaths } from "../src/paths";
import { TEST_TOKEN, tempAgentPaths, testConfig } from "./helpers";

describe("config store", () => {
  it("returns null before pairing", () => {
    expect(loadConfig(tempAgentPaths())).toBeNull();
  });

  it("round-trips the config with a private directory and file", () => {
    const paths = tempAgentPaths();
    const config = testConfig();
    saveConfig(paths, config);

    expect(loadConfig(paths)).toEqual(config);
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
    expect(configIsShared(paths)).toBe(false);
  });

  it("rejects a config that is not valid JSON or misses fields", () => {
    const paths = tempAgentPaths();
    saveConfig(paths, testConfig());
    writeFileSync(paths.configFile, "{");
    expect(() => loadConfig(paths)).toThrow(ConfigError);

    writeFileSync(paths.configFile, JSON.stringify({ serverUrl: "https://example.com" }));
    expect(() => loadConfig(paths)).toThrow(/deviceId/);
  });

  it("refuses to store a plain-http server URL for a remote host", () => {
    expect(() =>
      saveConfig(tempAgentPaths(), testConfig({ serverUrl: "http://example.com" })),
    ).toThrow();
  });

  it("redacts the token", () => {
    const redacted = redactConfig(testConfig());
    expect(redacted.token).toBe(REDACTED_TOKEN);
    expect(JSON.stringify(redacted)).not.toContain(TEST_TOKEN);
  });

  it("honours LOOMCAST_AGENT_HOME", () => {
    const paths = resolveAgentPaths({ LOOMCAST_AGENT_HOME: "/tmp/agent-home" });
    expect(paths.configFile).toBe("/tmp/agent-home/config.json");
    expect(paths.outboxDir).toBe("/tmp/agent-home/outbox");
    expect(paths.journalFile).toBe("/tmp/agent-home/journal.jsonl");
  });

  it("writes the file atomically without leftovers", () => {
    const paths = tempAgentPaths();
    saveConfig(paths, testConfig());
    saveConfig(paths, testConfig({ workspaceRoot: "/tmp/other" }));
    expect(JSON.parse(readFileSync(paths.configFile, "utf8")).workspaceRoot).toBe("/tmp/other");
  });
});
