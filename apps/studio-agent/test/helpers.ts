import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { AgentConfig } from "../src/config";
import { type AgentPaths, resolveAgentPaths } from "../src/paths";

export const ids = {
  device: "6f1f8f0e-5b8c-4e3a-9a59-1d1c2b3a4f50",
  job: "0b6c2f7e-8d4a-4c1e-9f3b-2a1d4e5f6a70",
  otherJob: "1c7d3a8f-9e5b-4d2f-8a4c-3b2e5f6a7b81",
  workspace: "2d8e4b9a-af6c-4e3a-9b5d-4c3f6a7b8c92",
} as const;

/** A syntactically valid device token for tests. */
export const TEST_TOKEN = `lc_dev_${"A1b2C3d4E5".repeat(4)}xyz`;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A random, syntactically valid job token, generated per test run. */
export function testJobToken(): string {
  const secret = [...randomBytes(43)].map((byte) => BASE62[byte % BASE62.length]).join("");
  return ["lc", "job", secret].join("_");
}

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A fresh agent home in a temporary directory, removed after the test. */
export function tempAgentPaths(): AgentPaths {
  const home = mkdtempSync(join(tmpdir(), "loomcast-agent-test-"));
  homes.push(home);
  return resolveAgentPaths({ LOOMCAST_AGENT_HOME: join(home, "state") });
}

export function testConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    serverUrl: "http://127.0.0.1:8790",
    deviceId: ids.device,
    token: TEST_TOKEN,
    workspaceRoot: "/tmp/loomcast-workspace",
    concurrency: { producer: 1, render: 1 },
    ...overrides,
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Resolves when `signal` aborts; for handlers that wait to be cancelled. */
export function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
    } else {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });
}
