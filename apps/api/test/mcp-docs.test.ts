import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mcpTools } from "@loomcast/contracts";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ListedTool,
  renderToolReference,
  replaceToolReference,
} from "../src/modules/mcp/reference";
import { connectClient, issueToken, type McpTestServer, startMcpTestServer } from "./mcp-support";
import { insertUser } from "./support";

/**
 * Keeps the tool reference in `docs/mcp.md` in step with what the server advertises. After adding
 * or changing a tool, regenerate it with:
 *
 *   UPDATE_MCP_DOCS=1 pnpm --filter @loomcast/api exec vitest run mcp-docs
 */
const DOCS_PATH = fileURLToPath(new URL("../../../docs/mcp.md", import.meta.url));

let testDb: TestDb;
let server: McpTestServer;

beforeAll(async () => {
  testDb = await createTestDb();
  server = await startMcpTestServer(testDb.db);
});

afterAll(async () => {
  await server?.close();
  await testDb?.drop();
});

describe("docs/mcp.md", () => {
  it("documents every tool the server lists", async () => {
    const user = await insertUser(testDb.db);
    const { secret } = await issueToken(server.deps, user.id, ["mcp:read"]);
    const client = await connectClient(server.url, secret);
    const { tools } = await client.listTools();
    await client.close();

    const reference = renderToolReference(tools as ListedTool[], mcpTools);
    const current = await readFile(DOCS_PATH, "utf8");
    const expected = replaceToolReference(current, reference);
    if (process.env.UPDATE_MCP_DOCS === "1" && expected !== current) {
      await writeFile(DOCS_PATH, expected);
      return;
    }
    expect(current, "regenerate with UPDATE_MCP_DOCS=1 (see the comment above)").toBe(expected);
  });
});
