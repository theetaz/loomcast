import { MCP_PATH } from "@loomcast/contracts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { forbidden } from "../../lib/errors";
import { consume, createRateLimiter, type RateLimitOptions } from "../../lib/rate-limit";
import type { AppEnv } from "../../types";
import { currentToken } from "../auth/guards";
import { CALLER_RESOLVERS, type CallerResolver, requireMcpCaller, resolveCaller } from "./caller";
import { createMcpServer } from "./server";
import { createMcpTools, registerTools, type ToolDefinition } from "./tools";

export {
  CALLER_RESOLVERS,
  type CallerBinding,
  type CallerResolver,
  type McpCaller,
} from "./caller";
export { createMcpServer, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./server";
export {
  createMcpTools,
  createProjectTools,
  defineTool,
  McpToolError,
  projectUrl,
  TOOL_CALL_AUDIT_ACTION,
  type ToolDefinition,
} from "./tools";

/** Tool calls and other MCP requests allowed per token: a burst of 120, refilling over a minute. */
export const MCP_RATE_LIMIT: RateLimitOptions = { capacity: 120, intervalMs: 60_000 };

/**
 * The same for a job token (`lc_job_…`): a producer session calls tools in quick bursts while it
 * works, so it gets 240 a minute. Each job token has a bucket of its own.
 */
export const MCP_JOB_RATE_LIMIT: RateLimitOptions = { capacity: 240, intervalMs: 60_000 };

/** Largest JSON-RPC request body accepted on `/mcp`. */
export const MCP_BODY_LIMIT_BYTES = 1024 * 1024;

export interface McpRouteOptions {
  /** Defaults to `MCP_PATH`. Tests mount extra endpoints elsewhere. */
  path?: string;
  /** Token kinds accepted. Defaults to `CALLER_RESOLVERS`. */
  resolvers?: readonly CallerResolver[];
  /** Tools served. Defaults to `createMcpTools(deps)`. */
  tools?: readonly ToolDefinition[];
}

/**
 * The MCP endpoint: streamable HTTP in stateless mode, so every POST gets its own server and
 * transport and the server never issues an `Mcp-Session-Id`. Responses are plain JSON.
 *
 * - Bearer tokens only: user MCP tokens (`lc_mcp_…`) and job tokens (`lc_job_…`) bound to one
 *   job's project. Cookies are never read.
 * - 120 requests a minute per user token, 240 per job token.
 * - A browser request from another origin is refused, against DNS rebinding.
 * - GET (a server-to-client event stream) and DELETE (ending a session) are not offered: 405.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  return registerMcpRoutes(app, deps);
}

export function registerMcpRoutes(
  app: Hono<AppEnv>,
  deps: ModuleDeps,
  options: McpRouteOptions = {},
): Hono<AppEnv> {
  const path = options.path ?? MCP_PATH;
  const resolvers = options.resolvers ?? CALLER_RESOLVERS;
  const tools = options.tools ?? createMcpTools(deps);
  const limiter = createRateLimiter(MCP_RATE_LIMIT, deps.clock);
  const jobLimiter = createRateLimiter(MCP_JOB_RATE_LIMIT, deps.clock);
  const router = new Hono<AppEnv>();

  router.use(path, async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== deps.config.appOrigin) {
      throw forbidden("Requests from other origins are not allowed.");
    }
    await next();
  });
  router.use(path, requireMcpCaller(deps, resolvers));
  router.use(path, async (c, next) => {
    const token = currentToken(c);
    consume(token.kind === "job" ? jobLimiter : limiter, token.id);
    await next();
  });

  router.post(path, async (c) => {
    const caller = await resolveCaller(c, deps, resolvers);
    const logger = c.get("logger");
    const server = createMcpServer();
    registerTools(server, tools, { caller, logger, db: deps.db });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MCP_BODY_LIMIT_BYTES,
    });
    logger.debug({ tokenId: caller.token.id }, "mcp request");
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  router.all(path, (c) => {
    c.header("Allow", "POST");
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. This server is stateless." },
        id: null,
      },
      405,
    );
  });

  app.route("/", router);
  return router;
}
