import { parseJobResult } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import { AGENT_VERSION } from "../src/agent-info";
import type { JobContext } from "../src/handlers";
import { createHandlers, optionalHandler } from "../src/jobs";
import { createLogger, silentLogger } from "../src/logger";
import { ids, tempAgentPaths, testConfig } from "./helpers";

function pingContext(events: string[]): JobContext<"system.ping"> {
  return {
    job: { id: ids.job, type: "system.ping", attempt: 1, projectId: ids.project, payload: {} },
    credentials: {},
    emit: (kind) => {
      events.push(kind);
    },
    stream: () => {},
    signal: new AbortController().signal,
    log: silentLogger,
  };
}

describe("job handlers", () => {
  const deps = { config: testConfig(), paths: tempAgentPaths(), log: silentLogger };

  it("registers system.ping and the producer jobs by default", async () => {
    const registry = await createHandlers(deps);
    expect(registry.types().sort()).toEqual([
      "kb.analyze_reference",
      "producer.chat",
      "system.ping",
    ]);
    const result = await registry.get("system.ping")?.(pingContext([]));
    expect(result?.producerAvailable).toBe(true);
  });

  it("registers only system.ping without optional handlers", async () => {
    const registry = await createHandlers(deps, []);
    expect(registry.types()).toEqual(["system.ping"]);
    expect(registry.has("producer.chat")).toBe(false);
  });

  it("system.ping reports the agent and runtime", async () => {
    const registry = await createHandlers(deps, []);
    const events: string[] = [];
    const result = await registry.get("system.ping")?.(pingContext(events));

    expect(parseJobResult("system.ping", result).success).toBe(true);
    expect(result).toMatchObject({
      agentVersion: AGENT_VERSION,
      runtime: { node: process.version },
      producerAvailable: false,
    });
    expect(events).toEqual(["status"]);
  });

  it("registers optional handlers and reports producer availability", async () => {
    const registry = await createHandlers(deps, [
      optionalHandler("producer.chat", async () => () => async () => ({
        sdkSessionId: "session-1",
        finalText: "ready",
        numTurns: 1,
        durationMs: 10,
      })),
    ]);
    expect(registry.types().sort()).toEqual(["producer.chat", "system.ping"]);
    const result = await registry.get("system.ping")?.(pingContext([]));
    expect(result?.producerAvailable).toBe(true);
  });

  it("skips an optional handler whose module fails to load", async () => {
    const lines: string[] = [];
    const registry = await createHandlers(
      { ...deps, log: createLogger({ write: (line) => lines.push(line) }) },
      [
        optionalHandler("producer.chat", async () => {
          throw new Error("Cannot find module");
        }),
      ],
    );
    expect(registry.types()).toEqual(["system.ping"]);
    expect(lines.join("")).toContain("job handler unavailable");
  });
});
