import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type ApiChannelGrant,
  type CreateApiClientResponse,
  CreateApiClientResponseSchema,
} from "@loomcast/contracts";
import { workspaces } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import type { ModuleDeps } from "../src/deps";
import type { Config } from "../src/env";
import { approvalsFor } from "../src/modules/approvals";
import { createTestApp, insertUser, login, send, type TestApp } from "./support";

// Shared setup of the API client tests: an app with a signed-in owner, a workspace, and helpers to
// create API clients through the owner's REST routes and call the machine API with their keys.

export interface ApiHarness {
  testDb: TestDb;
  t: TestApp;
  deps: ModuleDeps;
  ownerId: string;
  /** The owner's session cookie. */
  cookie: string;
  workspaceId: string;
  /** Sends a request as the signed-in owner, the way the web app does. */
  owner(method: string, path: string, body?: unknown): Promise<Response>;
  /** Creates an API client with these grants (in the harness workspace unless given). */
  createClient(
    grants: ApiChannelGrant[],
    extra?: { name?: string; workspaceId?: string; expiresAt?: string },
  ): Promise<CreateApiClientResponse>;
  /** Waits for the bus-driven approval rules to settle. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export async function createApiHarness(
  options: { config?: Partial<Config> } = {},
): Promise<ApiHarness> {
  const testDb = await createTestDb();
  let deps: ModuleDeps | undefined;
  const t = createTestApp(testDb.db, {
    ...(options.config === undefined ? {} : { config: options.config }),
    modules: [
      (app, captured) => {
        deps = captured;
        return app;
      },
    ],
  });
  if (deps === undefined) throw new Error("module deps were not captured");
  const captured = deps;
  const user = await insertUser(testDb.db, { role: "owner" });
  const { cookie } = await login(t.app, user.email);
  const [workspace] = await testDb.db
    .insert(workspaces)
    .values({ slug: `api-${randomUUID().slice(0, 8)}`, name: "API posts", createdBy: user.id })
    .returning();
  if (workspace === undefined) throw new Error("workspace was not inserted");

  const owner = (method: string, path: string, body?: unknown) =>
    send(t.app, method, path, { cookie, body });

  return {
    testDb,
    t,
    deps: captured,
    ownerId: user.id,
    cookie,
    workspaceId: workspace.id,
    owner,
    async createClient(grants, extra = {}) {
      const response = await owner("POST", "/api/api-clients", {
        name: extra.name ?? `client ${randomUUID().slice(0, 6)}`,
        workspaceId: extra.workspaceId ?? workspace.id,
        grants,
        ...(extra.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
      });
      if (response.status !== 201) {
        throw new Error(`client was not created: ${response.status} ${await response.text()}`);
      }
      return CreateApiClientResponseSchema.parse(await response.json());
    },
    async settle() {
      for (let round = 0; round < 5; round += 1) {
        await approvalsFor(captured).work.idle();
      }
    },
    async close() {
      await t.deps.lifecycle.close();
      await testDb.drop();
    },
  };
}

/** Calls the machine API with `key`, as another backend would: no cookie, no Origin. */
export function machine(
  t: TestApp,
  key: string | null,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; cookie?: string } = {},
): Promise<Response> {
  return send(t.app, method, path, {
    origin: null,
    ...(options.body === undefined ? { contentType: null } : {}),
    body: options.body,
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    headers: {
      ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
      ...options.headers,
    },
  });
}

const SIGNATURES = {
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d],
  "video/mp4": [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d],
} as const;

/** Random bytes that start like a file of `mime`, with their SHA-256. */
export function mediaFile(
  mime: keyof typeof SIGNATURES,
  size = 4 * 1024,
): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.concat([Buffer.from(SIGNATURES[mime]), randomBytes(size)]);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
