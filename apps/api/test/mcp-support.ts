import type { TokenScope } from "@loomcast/contracts";
import type { Database } from "@loomcast/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppDeps } from "../src/deps";
import { createEventBus } from "../src/lib/bus";
import { createLifecycle } from "../src/lib/lifecycle";
import { createLogger } from "../src/lib/logger";
import { createTokensService } from "../src/modules/tokens/service";
import { type RunningServer, startServer } from "../src/server";
import { createTestClock, type TestClock, testConfig } from "./support";

export interface McpTestServer {
  deps: AppDeps;
  running: RunningServer;
  clock: TestClock;
  /** Base URL of the server, without a path. */
  origin: string;
  /** URL of the MCP endpoint. */
  url: URL;
  close(): Promise<void>;
}

/** The API served over real HTTP on a free port, so the MCP client speaks to it as in production. */
export async function startMcpTestServer(db: Database): Promise<McpTestServer> {
  const logger = createLogger({ level: "silent" });
  const clock = createTestClock();
  const deps: AppDeps = {
    db,
    bus: createEventBus(logger),
    clock,
    logger,
    config: testConfig({ trustProxy: false }),
    lifecycle: createLifecycle(logger),
  };
  const running = await startServer(deps, { port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${running.port}`;
  return {
    deps,
    running,
    clock,
    origin,
    url: new URL("/mcp", origin),
    close: () => running.close(1_000),
  };
}

/** Issues a token the way Settings does. The secret is generated, never written in a test. */
export async function issueToken(
  deps: Pick<AppDeps, "db" | "clock">,
  userId: string,
  scopes: readonly TokenScope[],
  kind: "mcp" | "device" = "mcp",
) {
  return createTokensService(deps).create({ userId, kind, name: `test ${kind} token`, scopes });
}

/** An MCP client connected to `url` with `secret` as its bearer token. */
export async function connectClient(url: URL, secret?: string): Promise<Client> {
  const client = new Client({ name: "loomcast-test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: secret === undefined ? {} : { Authorization: `Bearer ${secret}` },
    },
  });
  await client.connect(transport);
  return client;
}

/** One JSON-RPC request posted the way a streamable HTTP client posts it. */
export function rpc(
  url: URL,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

export function bearer(secret: string): Record<string, string> {
  return { Authorization: `Bearer ${secret}` };
}
