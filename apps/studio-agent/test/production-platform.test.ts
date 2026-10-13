import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpCredentials } from "../src/handlers";
import {
  createPlatformClient,
  mcpPlatformConnector,
  PlatformError,
} from "../src/production/platform";
import { testJobToken } from "./helpers";
import { contentItem, contentVersion, itemId, versionId } from "./production-fakes";

const content = { item: contentItem(), version: contentVersion(), format: null };

/** A fake platform MCP server with the tools the studio agent calls. */
function fakeMcpServer(seen: { name: string; args: unknown }[] = []): McpServer {
  const server = new McpServer({ name: "fake-loomcast", version: "0.0.0" });
  server.registerTool(
    "content.get",
    { inputSchema: { itemId: z.string(), versionId: z.string().optional() } },
    async (args) => {
      seen.push({ name: "content.get", args });
      return {
        content: [{ type: "text", text: "Item" }],
        structuredContent: content as unknown as Record<string, unknown>,
      };
    },
  );
  server.registerTool(
    "content.finalize_asset",
    { inputSchema: { assetId: z.string() } },
    async () => ({
      content: [{ type: "text", text: "upload_missing: The uploaded file was not found." }],
      isError: true,
    }),
  );
  server.registerTool("skill.pull", { inputSchema: { name: z.string().optional() } }, async () => ({
    content: [{ type: "text", text: "Skills" }],
    structuredContent: { skills: [{ name: "Not A Valid Name" }] },
  }));
  return server;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function credentials(url = "http://127.0.0.1:1/mcp", token = testJobToken()) {
  return createMcpCredentials(new URL(url), token, new Date(Date.now() + 60_000).toISOString());
}

describe("platform client over MCP", () => {
  it("returns structured content checked against the contracts", async () => {
    const seen: { name: string; args: unknown }[] = [];
    const server = fakeMcpServer(seen);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const connect = mcpPlatformConnector(() => clientTransport);
    const platform = await connect(credentials(), new AbortController().signal);

    expect(await platform.getContent({ itemId, versionId })).toEqual(content);
    expect(seen).toEqual([{ name: "content.get", args: { itemId, versionId } }]);

    await expect(platform.finalizeAsset({ assetId: versionId })).rejects.toMatchObject({
      name: "PlatformError",
      code: "upload_missing",
      tool: "content.finalize_asset",
      message: "content.finalize_asset failed: The uploaded file was not found.",
    });
    await expect(platform.pullSkills({})).rejects.toMatchObject({ code: "invalid_response" });
    await platform.close();
  });

  it("sends the job token as a bearer token over streamable HTTP", async () => {
    const authorizations: (string | undefined)[] = [];
    const http = createServer(async (request: IncomingMessage, response) => {
      authorizations.push(request.headers.authorization);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body =
        chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      // Stateless, JSON answers: a new server and transport per request, like the platform's.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = fakeMcpServer();
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    });
    servers.push(http);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const token = testJobToken();

    const platform = await mcpPlatformConnector()(
      credentials(`http://127.0.0.1:${port}/mcp`, token),
      new AbortController().signal,
    );
    expect((await platform.getContent({ itemId })).item.id).toBe(itemId);
    await platform.close();

    const posts = authorizations.filter((value) => value !== undefined);
    expect(posts.length).toBeGreaterThan(0);
    expect(new Set(posts)).toEqual(new Set([`Bearer ${token}`]));
  });

  it("reports an unreachable server as a retryable transport failure", async () => {
    const http = createServer((_request, response) => response.writeHead(503).end());
    servers.push(http);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const failure = await mcpPlatformConnector()(
      credentials(`http://127.0.0.1:${port}/mcp`),
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlatformError);
    expect(failure).toMatchObject({ code: "transport", retryable: true });
  });

  it("maps tool errors without a code and thrown calls", async () => {
    const signal = new AbortController().signal;
    const plain = createPlatformClient(
      async () => ({ isError: true, content: [{ type: "text", text: "Something broke" }] }),
      signal,
    );
    await expect(plain.getAssetUrl({ assetId: versionId })).rejects.toMatchObject({
      code: "tool_failed",
      retryable: false,
    });
    const offline = createPlatformClient(async () => {
      throw new Error("socket hang up");
    }, signal);
    await expect(offline.getContent({ itemId })).rejects.toMatchObject({
      code: "transport",
      retryable: true,
    });
  });
});
