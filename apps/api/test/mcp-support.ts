import type { TokenScope } from "@loomcast/contracts";
import { apiTokens, type Database, jobs } from "@loomcast/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppDeps, RegisterModule } from "../src/deps";
import type { Config } from "../src/env";
import { createEventBus } from "../src/lib/bus";
import { generatePrefixedToken } from "../src/lib/crypto";
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
export async function startMcpTestServer(
  db: Database,
  modules: readonly RegisterModule[] = [],
  config: Partial<Config> = {},
): Promise<McpTestServer> {
  const logger = createLogger({ level: "silent" });
  const clock = createTestClock();
  const deps: AppDeps = {
    db,
    bus: createEventBus(logger),
    clock,
    logger,
    config: testConfig({ trustProxy: false, ...config }),
    lifecycle: createLifecycle(logger),
  };
  const running = await startServer(deps, { port: 0, host: "127.0.0.1", modules });
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

/**
 * A running job with a job token bound to it, inserted the way the bridge will mint one for a
 * producer session.
 */
export async function issueJobToken(
  db: Database,
  values: { userId: string; projectId: string; scopes: readonly TokenScope[] },
) {
  const [job] = await db
    .insert(jobs)
    .values({
      type: "system.ping",
      status: "running",
      projectId: values.projectId,
      payload: {},
      createdBy: values.userId,
    })
    .returning();
  if (job === undefined) {
    throw new Error("job was not inserted");
  }
  const generated = generatePrefixedToken("job");
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId: values.userId,
      kind: "job",
      name: `job ${job.id}`,
      tokenHash: generated.hash,
      prefix: generated.prefix,
      scopes: [...values.scopes],
      projectId: values.projectId,
      jobId: job.id,
    })
    .returning();
  if (row === undefined) {
    throw new Error("job token was not inserted");
  }
  return { secret: generated.secret, job, row };
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
