import { describe, expect, it } from "vitest";
import { AGENT_VERSION, detectPlatform } from "../src/agent-info";
import { loadConfig, saveConfig } from "../src/config";
import { PairingError, pairDevice } from "../src/pair";
import { ids, TEST_TOKEN, tempAgentPaths, testConfig } from "./helpers";

interface Captured {
  url?: string;
  init?: RequestInit;
}

function fakeFetch(status: number, body: unknown, captured: Captured = {}): typeof fetch {
  return async (input, init) => {
    captured.url = String(input);
    captured.init = init;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("pairDevice", () => {
  it("posts the code, platform and version and stores the token", async () => {
    const paths = tempAgentPaths();
    const captured: Captured = {};
    const config = await pairDevice(
      {
        server: "http://127.0.0.1:8790/settings",
        code: " abcd-efgh ",
        name: "Studio Mac",
        fetch: fakeFetch(201, { deviceId: ids.device, token: TEST_TOKEN }, captured),
      },
      paths,
    );

    expect(captured.url).toBe("http://127.0.0.1:8790/api/bridge/pair");
    expect(captured.init?.method).toBe("POST");
    expect(JSON.parse(String(captured.init?.body))).toEqual({
      code: "ABCD-EFGH",
      name: "Studio Mac",
      platform: detectPlatform(),
      agentVersion: AGENT_VERSION,
    });
    expect(config).toMatchObject({ serverUrl: "http://127.0.0.1:8790", deviceId: ids.device });
    expect(loadConfig(paths)).toEqual(config);
  });

  it("keeps the workspace root and concurrency of an earlier pairing", async () => {
    const paths = tempAgentPaths();
    saveConfig(
      paths,
      testConfig({ workspaceRoot: "/tmp/custom", concurrency: { producer: 2, render: 0 } }),
    );
    const config = await pairDevice(
      {
        server: "http://localhost:8790",
        code: "ABCD-EFGH",
        name: "Mac",
        fetch: fakeFetch(201, { deviceId: ids.device, token: TEST_TOKEN }),
      },
      paths,
    );
    expect(config.workspaceRoot).toBe("/tmp/custom");
    expect(config.concurrency).toEqual({ producer: 2, render: 0 });
  });

  it("rejects a malformed code before calling the server", async () => {
    let called = false;
    const fetch: typeof globalThis.fetch = async () => {
      called = true;
      return new Response(null, { status: 500 });
    };
    await expect(
      pairDevice(
        { server: "http://localhost:8790", code: "nope", name: "Mac", fetch },
        tempAgentPaths(),
      ),
    ).rejects.toThrow(PairingError);
    expect(called).toBe(false);
  });

  it("reports the server's error and stores nothing", async () => {
    const paths = tempAgentPaths();
    await expect(
      pairDevice(
        {
          server: "http://localhost:8790",
          code: "ABCD-EFGH",
          name: "Mac",
          fetch: fakeFetch(400, { error: { code: "bad_request", message: "Code expired" } }),
        },
        paths,
      ),
    ).rejects.toThrow("Pairing was refused (HTTP 400): Code expired");
    expect(loadConfig(paths)).toBeNull();
  });

  it("rejects a response without a valid device token", async () => {
    await expect(
      pairDevice(
        {
          server: "http://localhost:8790",
          code: "ABCD-EFGH",
          name: "Mac",
          fetch: fakeFetch(201, { deviceId: ids.device, token: "secret" }),
        },
        tempAgentPaths(),
      ),
    ).rejects.toThrow("unexpected pairing response");
  });
});
