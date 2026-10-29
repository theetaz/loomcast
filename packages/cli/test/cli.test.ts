import { describe, expect, it } from "vitest";
import { DEFAULT_URL, parseEnvFile, resolveConfig } from "../src/config";
import { type CliIo, EXIT, main, oneLine, parseCommandLine, sinceOption } from "../src/main";
import { createMcpClient, parseEventStream, responseFor } from "../src/mcp";

// The CLI against a fake fetch: argument parsing, configuration, both answer formats of the
// streamable HTTP transport, the admin retry, and that no token ever reaches the output.

const TOKEN = `lc_mcp_${"r".repeat(32)}`;
const ADMIN_TOKEN = `lc_mcp_${"a".repeat(32)}`;

interface Sent {
  url: string;
  authorization: string | null;
  accept: string | null;
  body: { jsonrpc: string; id: number; method: string; params?: Record<string, unknown> };
}

type Answer = (sent: Sent) => Response;

function jsonAnswer(sent: Sent, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: sent.body.id, result }), {
    headers: { "content-type": "application/json" },
  });
}

function sseAnswer(sent: Sent, result: unknown): Response {
  const message = JSON.stringify({ jsonrpc: "2.0", id: sent.body.id, result });
  return new Response(`: keep-alive\n\nevent: message\ndata: ${message}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

const TOOLS = [
  {
    name: "research.top_topics",
    description: "The topic leaderboard of a workspace's research: tagged videos. More text.",
    inputSchema: { type: "object", properties: { workspace: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "research.add_videos",
    description:
      "Owner only. Store up to 100 videos found elsewhere. Unknown accounts are created.",
    inputSchema: { type: "object" },
  },
];

function harness(
  options: {
    answer?: Answer;
    env?: Record<string, string>;
    file?: string | null;
    stdin?: string | null;
  } = {},
) {
  const sent: Sent[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const answer: Answer =
    options.answer ??
    ((request) => {
      if (request.body.method === "tools/list") return jsonAnswer(request, { tools: TOOLS });
      return jsonAnswer(request, {
        content: [{ type: "text", text: `called ${String(request.body.params?.name)}` }],
        structuredContent: { echo: request.body.params?.arguments },
      });
    });
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: options.env ?? { LOOMCAST_TOKEN: TOKEN, LOOMCAST_URL: "https://loomcast.test" },
    readTokenFile: async () => options.file ?? null,
    readFile: async (path) => {
      if (path === "args.json") return '{"workspace":"from-file"}';
      throw new Error(`no file ${path}`);
    },
    readStdin: async () => options.stdin ?? null,
    now: () => new Date("2026-10-19T00:00:00.000Z"),
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      const request: Sent = {
        url,
        authorization: headers.get("authorization"),
        accept: headers.get("accept"),
        body: JSON.parse(String(init.body)),
      };
      sent.push(request);
      return answer(request);
    },
  };
  return {
    io,
    sent,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    run: (...argv: string[]) => main(argv, io),
  };
}

describe("command line", () => {
  it("takes options before or after the command and refuses ones that do not apply", () => {
    expect(parseCommandLine(["--url", "https://x.test", "topics", "--days", "30"])).toEqual({
      command: "topics",
      positionals: [],
      values: { url: "https://x.test", days: "30" },
    });
    expect(parseCommandLine(["call", "kb.search", "--args", "{}", "--json"])).toMatchObject({
      command: "call",
      positionals: ["kb.search"],
      values: { args: "{}", json: true },
    });
    expect(() => parseCommandLine(["tools", "--days", "3"])).toThrow(/does not apply to "tools"/);
    expect(() => parseCommandLine(["launch"])).toThrow(/Unknown command "launch"/);
    expect(() => parseCommandLine(["topics", "--nope"])).toThrow();
  });

  it("reads --since as an ISO time or a number of days", () => {
    const now = new Date("2026-10-19T00:00:00.000Z");
    expect(sinceOption("30d", now)).toBe("2026-09-19T00:00:00.000Z");
    expect(sinceOption("2026-10-01", now)).toBe("2026-10-01T00:00:00.000Z");
    expect(sinceOption(undefined, now)).toBeUndefined();
    expect(() => sinceOption("last week", now)).toThrow(/--since/);
  });

  it("shortens descriptions to their first sentence", () => {
    expect(oneLine("List workspaces, optionally filtered. More.")).toBe(
      "List workspaces, optionally filtered.",
    );
    expect(oneLine("Owner only. Cancel a post. Details.")).toBe("Owner only. Cancel a post.");
    expect(oneLine(`${"x".repeat(150)}.`)).toHaveLength(100);
  });

  it("prints help everywhere without a token", async () => {
    const h = harness({ env: {} });
    expect(await h.run("--help")).toBe(EXIT.ok);
    expect(h.stdout()).toContain("Usage: loomcast <command>");
    expect(await h.run("videos", "--help")).toBe(EXIT.ok);
    expect(h.stdout()).toContain("--untagged");
    expect(await h.run()).toBe(EXIT.usage);
    expect(h.sent).toHaveLength(0);
  });
});

describe("configuration", () => {
  it("parses env files", () => {
    expect(
      parseEnvFile(
        `# tokens\nexport LOOMCAST_MCP_TOKEN="abc"\nLOOMCAST_URL = 'https://x.test'\n\nnot a pair\n`,
      ),
    ).toEqual({ LOOMCAST_MCP_TOKEN: "abc", LOOMCAST_URL: "https://x.test" });
  });

  it("prefers the environment, then the file, and keeps the owner token for a retry", () => {
    const file = `LOOMCAST_MCP_TOKEN=${TOKEN}\nLOOMCAST_MCP_ADMIN_TOKEN=${ADMIN_TOKEN}\n`;
    expect(resolveConfig({ env: {}, file })).toEqual({
      url: DEFAULT_URL,
      token: TOKEN,
      adminToken: ADMIN_TOKEN,
      workspace: null,
    });
    expect(resolveConfig({ env: {}, file, admin: true })).toMatchObject({
      token: ADMIN_TOKEN,
      adminToken: null,
    });
    expect(
      resolveConfig({ env: { LOOMCAST_TOKEN: "env-token", LOOMCAST_WORKSPACE: "unfolded" }, file }),
    ).toMatchObject({ token: "env-token", adminToken: null, workspace: "unfolded" });
    expect(
      resolveConfig({ env: {}, file: `LOOMCAST_MCP_ADMIN_TOKEN=${ADMIN_TOKEN}` }),
    ).toMatchObject({ token: ADMIN_TOKEN });
    expect(resolveConfig({ env: {}, file, url: "http://localhost:8790/" }).url).toBe(
      "http://localhost:8790",
    );
    expect(() => resolveConfig({ env: {}, file: null })).toThrow(/No access token/);
    expect(() =>
      resolveConfig({ env: {}, file: `LOOMCAST_MCP_TOKEN=${TOKEN}`, admin: true }),
    ).toThrow(/--admin needs/);
    expect(() => resolveConfig({ env: {}, file, url: "ftp://x" })).toThrow(/http/);
  });
});

describe("responses", () => {
  it("reads event streams and plain JSON, picking the response to the request", () => {
    const body =
      ': comment\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' +
      'data: {"jsonrpc":"2.0",\ndata: "id":7,"result":{"ok":true}}\n\n';
    expect(parseEventStream(body)).toEqual([
      { jsonrpc: "2.0", method: "notifications/progress" },
      { jsonrpc: "2.0", id: 7, result: { ok: true } },
    ]);
    expect(responseFor(7, "text/event-stream; charset=utf-8", body).result).toEqual({ ok: true });
    expect(
      responseFor(
        2,
        "application/json",
        '[{"jsonrpc":"2.0","id":1},{"jsonrpc":"2.0","id":2,"result":5}]',
      ).result,
    ).toBe(5);
    expect(() => responseFor(3, "application/json", '{"jsonrpc":"2.0","id":4}')).toThrow(
      /did not include/,
    );
    expect(() => responseFor(3, "application/json", "<html>")).toThrow(/not JSON/);
  });

  it("posts JSON-RPC with the bearer token and both accept types, and follows tool pages", async () => {
    const h = harness({
      answer: (sent) =>
        sent.body.params?.cursor === undefined
          ? sseAnswer(sent, { tools: [TOOLS[0]], nextCursor: "page2" })
          : jsonAnswer(sent, { tools: [TOOLS[1]] }),
    });
    const client = createMcpClient({
      url: "https://loomcast.test",
      token: TOKEN,
      fetch: h.io.fetch,
    });
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["research.top_topics", "research.add_videos"]);
    expect(h.sent[0]).toMatchObject({
      url: "https://loomcast.test/mcp",
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json, text/event-stream",
      body: { jsonrpc: "2.0", method: "tools/list" },
    });
    expect(h.sent[1]?.body.params).toEqual({ cursor: "page2" });
  });
});

describe("commands", () => {
  it("lists and describes tools", async () => {
    const h = harness();
    expect(await h.run("tools")).toBe(EXIT.ok);
    expect(h.stdout()).toBe(
      "research.add_videos  Owner only. Store up to 100 videos found elsewhere.\n" +
        "research.top_topics  The topic leaderboard of a workspace's research: tagged videos.\n",
    );
    const d = harness();
    expect(await d.run("describe", "research.top_topics")).toBe(EXIT.ok);
    expect(d.stdout()).toContain("research.top_topics (read-only)");
    expect(d.stdout()).toContain('"workspace"');
    expect(await d.run("describe", "nope.tool")).toBe(EXIT.failed);
  });

  it("calls a tool with arguments from --args, a file or stdin", async () => {
    const h = harness();
    expect(await h.run("call", "kb.search", "--args", '{"query":"hooks"}')).toBe(EXIT.ok);
    expect(h.stdout()).toBe("called kb.search\n");
    expect(h.sent[0]?.body).toMatchObject({
      method: "tools/call",
      params: { name: "kb.search", arguments: { query: "hooks" } },
    });

    const file = harness();
    expect(
      await file.run("call", "research.top_topics", "--args-file", "args.json", "--json"),
    ).toBe(EXIT.ok);
    expect(JSON.parse(file.stdout())).toEqual({ echo: { workspace: "from-file" } });

    const piped = harness({ stdin: '{"workspace":"piped"}\n' });
    await piped.run("call", "research.top_topics");
    expect(piped.sent[0]?.body.params?.arguments).toEqual({ workspace: "piped" });

    const bad = harness();
    expect(await bad.run("call", "kb.search", "--args", "[1]")).toBe(EXIT.usage);
    expect(bad.stderr()).toContain("must be a JSON object");
    expect(bad.sent).toHaveLength(0);
  });

  it("exits with 1 when the tool reports an error and prints it on stderr", async () => {
    const h = harness({
      answer: (sent) =>
        jsonAnswer(sent, {
          content: [{ type: "text", text: "not_found: No workspace." }],
          isError: true,
        }),
    });
    expect(await h.run("topics", "--workspace", "nope")).toBe(EXIT.failed);
    expect(h.stderr()).toBe("not_found: No workspace.\n");
  });

  it("retries once with the owner token when a tool needs mcp:admin", async () => {
    const h = harness({
      env: {},
      file: `LOOMCAST_MCP_TOKEN=${TOKEN}\nLOOMCAST_MCP_ADMIN_TOKEN=${ADMIN_TOKEN}\n`,
      answer: (sent) =>
        sent.authorization === `Bearer ${ADMIN_TOKEN}`
          ? jsonAnswer(sent, {
              content: [{ type: "text", text: "Stored 1 new." }],
              structuredContent: {},
            })
          : jsonAnswer(sent, {
              content: [
                {
                  type: "text",
                  text: "forbidden: This tool needs the mcp:admin scope, which the token does not have.",
                },
              ],
              isError: true,
            }),
    });
    expect(
      await h.run("call", "research.add_videos", "--args", '{"workspace":"p","videos":[]}'),
    ).toBe(EXIT.ok);
    expect(h.sent.map((sent) => sent.authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${ADMIN_TOKEN}`,
    ]);
    expect(h.stdout()).toBe("Stored 1 new.\n");
  });

  it("maps the shortcuts to their tools", async () => {
    const h = harness({ env: { LOOMCAST_TOKEN: TOKEN, LOOMCAST_WORKSPACE: "unfolded" } });
    await h.run("topics", "--days", "30", "--min-hits", "2");
    await h.run("videos", "--untagged", "--since", "7d", "--min-outlier", "4.5", "--sort", "views");
    await h.run("accounts", "--workspace", "other");
    await h.run("posts", "--limit", "5");
    expect(h.sent.map((sent) => [sent.body.params?.name, sent.body.params?.arguments])).toEqual([
      ["research.top_topics", { workspace: "unfolded", windowDays: 30, minHitCreators: 2 }],
      [
        "research.list_videos",
        {
          workspace: "unfolded",
          untaggedOnly: true,
          minOutlier: 4.5,
          since: "2026-10-12T00:00:00.000Z",
          sort: "views",
        },
      ],
      ["research.list_accounts", { workspace: "other" }],
      ["analytics.list_posts", { workspace: "unfolded", limit: 5 }],
    ]);

    const noWorkspace = harness();
    expect(await noWorkspace.run("topics")).toBe(EXIT.usage);
    expect(noWorkspace.stderr()).toContain("--workspace");
    expect(await noWorkspace.run("topics", "--workspace", "p", "--days", "many")).toBe(EXIT.usage);
  });

  it("never prints the token, even when the server refuses it", async () => {
    const h = harness({
      answer: () =>
        new Response(
          JSON.stringify({ error: { code: "unauthorized", message: "Invalid token." } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
    });
    expect(await h.run("tools")).toBe(EXIT.failed);
    expect(h.stderr()).toContain("The token was refused");
    expect(h.stdout() + h.stderr()).not.toContain(TOKEN);

    const down = harness({
      answer: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await down.run("tools")).toBe(EXIT.failed);
    expect(down.stderr()).toBe("Cannot reach https://loomcast.test/mcp: fetch failed\n");
  });
});
