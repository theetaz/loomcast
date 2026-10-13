import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { readSecret, secretsFile, setSecret, unsetSecret } from "../src/config";
import { voiceKeyReader } from "../src/production/deps";
import { tempAgentPaths } from "./helpers";
import { fakeStudio, tempDir } from "./production-fakes";

/** A random secret value, generated per test. */
function secretValue(): string {
  return ["sk", randomBytes(24).toString("hex")].join("_");
}

function cli(home: string, input = "") {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    run: (argv: string[]) =>
      runCli(argv, {
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        env: { LOOMCAST_AGENT_HOME: home },
        readSecret: async () => input,
      }),
  };
}

describe("agent secrets", () => {
  it("stores the voice provider key in a 0600 file inside the 0700 state directory", () => {
    const paths = tempAgentPaths();
    const value = secretValue();
    setSecret(paths, "voice-provider-key", value);

    expect(statSync(secretsFile(paths)).mode & 0o777).toBe(0o600);
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
    expect(readFileSync(secretsFile(paths), "utf8")).toBe(`LOOMCAST_VOICE_PROVIDER_KEY=${value}\n`);
    expect(readSecret(paths, "voice-provider-key")).toBe(value);

    expect(unsetSecret(paths, "voice-provider-key")).toBe(true);
    expect(readSecret(paths, "voice-provider-key")).toBeUndefined();
    expect(unsetSecret(paths, "voice-provider-key")).toBe(false);
    expect(statSync(secretsFile(paths)).mode & 0o777).toBe(0o600);
  });

  it("refuses values with spaces, line breaks or nothing in them", () => {
    const paths = tempAgentPaths();
    for (const value of ["", "   ", "two words", "line\nbreak"]) {
      expect(() => setSecret(paths, "voice-provider-key", value)).toThrow();
    }
  });

  it("sets and unsets the key from the CLI without printing it", async () => {
    const paths = tempAgentPaths();
    const value = secretValue();
    const io = cli(paths.home, `${value}\n`);
    expect(await io.run(["secrets", "set", "voice-provider-key"])).toBe(0);
    expect(readSecret(paths, "voice-provider-key")).toBe(value);
    expect(io.out.join("")).not.toContain(value);
    expect(io.out.join("")).toContain("readable only by you");

    expect(await io.run(["secrets", "unset", "voice-provider-key"])).toBe(0);
    expect(readSecret(paths, "voice-provider-key")).toBeUndefined();
  });

  it("rejects unknown secret names and a value given as an argument", async () => {
    const paths = tempAgentPaths();
    const io = cli(paths.home, secretValue());
    expect(await io.run(["secrets", "set", "other-key"])).toBe(1);
    expect(await io.run(["secrets", "set", "voice-provider-key", secretValue()])).toBe(1);
    expect(await io.run(["secrets", "show", "voice-provider-key"])).toBe(1);
    expect(io.err.join("")).toContain("Usage: studio-agent secrets");
  });

  it("reads the agent's key before the studio's", async () => {
    const paths = tempAgentPaths();
    const studio = fakeStudio(tempDir());
    const studioValue = secretValue();
    studio.readVoiceProviderKey = () => studioValue;
    const read = voiceKeyReader(paths, async () => studio);
    expect(await read()).toBe(studioValue);
    const value = secretValue();
    setSecret(paths, "voice-provider-key", value);
    expect(await read()).toBe(value);
  });
});
