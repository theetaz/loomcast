// A small MCP client: JSON-RPC over HTTP POST, as the streamable HTTP transport sends it. The
// Loomcast server is stateless and answers each request on its own, so there is no session and
// no initialize handshake. Answers come as plain JSON or as a `text/event-stream`; both are read.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** A failure talking to the server: HTTP, transport or a JSON-RPC error. */
export class McpError extends Error {
  override readonly name = "McpError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The JSON-RPC messages of a `text/event-stream` body: each event's `data:` lines joined with
 * newlines and parsed as JSON. Events without data, comments and unparsable data are skipped.
 */
export function parseEventStream(body: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.length === 0) continue;
    try {
      messages.push(JSON.parse(data.join("\n")));
    } catch {
      // Not JSON: not a message for us.
    }
  }
  return messages;
}

/**
 * The response to request `id` in an HTTP answer, from a JSON body (one message or a batch) or an
 * event stream.
 */
export function responseFor(id: number, contentType: string, body: string): JsonRpcResponse {
  let messages: unknown[];
  if (contentType.includes("text/event-stream")) {
    messages = parseEventStream(body);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new McpError("The server answered with something that is not JSON.");
    }
    messages = Array.isArray(parsed) ? parsed : [parsed];
  }
  const match = messages.find(
    (message): message is JsonRpcResponse => isObject(message) && message.id === id,
  );
  if (match === undefined) {
    throw new McpError("The server's answer did not include a response to the request.");
  }
  return match;
}

/** A short reason for a refused HTTP request. The token is never part of it. */
function httpFailure(status: number, body: string): McpError {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isObject(parsed)) {
      const error = parsed.error;
      if (isObject(error) && typeof error.message === "string") detail = error.message;
    }
  } catch {
    detail = body.slice(0, 200).trim();
  }
  const hint =
    status === 401
      ? "The token was refused: it may be wrong, expired or revoked."
      : status === 429
        ? "Too many requests: wait a minute and try again."
        : `The server answered ${status}.`;
  return new McpError(detail === "" ? hint : `${hint} ${detail}`, status);
}

export interface McpClientOptions {
  /** The server's origin; requests go to `<url>/mcp`. */
  url: string;
  token: string;
  fetch?: FetchLike;
}

export interface McpClient {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export function createMcpClient(options: McpClientOptions): McpClient {
  const endpoint = `${options.url}/mcp`;
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  let nextId = 1;

  async function request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    let response: Response;
    try {
      response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new McpError(`Cannot reach ${endpoint}: ${reason}`);
    }
    const body = await response.text();
    if (!response.ok) {
      throw httpFailure(response.status, body);
    }
    const answer = responseFor(id, response.headers.get("content-type") ?? "", body);
    if (answer.error !== undefined) {
      throw new McpError(
        `${answer.error.message ?? "JSON-RPC error"} (${answer.error.code ?? "?"})`,
      );
    }
    return answer.result;
  }

  return {
    request,

    async listTools() {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      // Follow `nextCursor` pages, with a bound in case a server keeps answering one.
      for (let page = 0; page < 50; page += 1) {
        const result = await request("tools/list", cursor === undefined ? {} : { cursor });
        if (!isObject(result) || !Array.isArray(result.tools)) {
          throw new McpError("The server's tool list is not in the expected shape.");
        }
        tools.push(...(result.tools as Tool[]));
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
        if (cursor === undefined) break;
      }
      return tools;
    },

    async callTool(name, args) {
      const result = await request("tools/call", { name, arguments: args });
      if (!isObject(result)) {
        throw new McpError("The server's tool result is not in the expected shape.");
      }
      return result as ToolResult;
    },
  };
}

/** The text items of a tool result, joined by blank lines. */
export function resultText(result: ToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n\n");
}

/** Whether a failed call was refused for lacking `mcp:admin`, so an owner token may succeed. */
export function needsAdmin(result: ToolResult): boolean {
  return result.isError === true && /^forbidden: .*mcp:admin/.test(resultText(result));
}
