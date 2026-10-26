import { randomUUID } from "node:crypto";
import { API_KEY_RE, ApiClientSchema, listSchema } from "@loomcast/contracts";
import { auditLog, workspaces } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, machine } from "./api-support";
import { insertChannel, testKeyring } from "./publisher-support";
import { errorCode, insertUser, insertWorkspace, login, send } from "./support";

// The owner's API clients over REST: create with grants (the key shown once), list, change the
// grants, revoke. Admins are refused; every change is audited without the key.

const keyring = testKeyring();
let h: ApiHarness;
let facebookId: string;
let instagramId: string;
let adminCookie: string;

beforeAll(async () => {
  h = await createApiHarness();
  facebookId = (
    await insertChannel(h.testDb.db, keyring, { workspaceId: h.workspaceId, platform: "facebook" })
  ).id;
  instagramId = (
    await insertChannel(h.testDb.db, keyring, { workspaceId: h.workspaceId, platform: "instagram" })
  ).id;
  const admin = await insertUser(h.testDb.db, { role: "admin" });
  ({ cookie: adminCookie } = await login(h.t.app, admin.email));
});

afterAll(async () => {
  await h.close();
});

const ListSchema = listSchema(ApiClientSchema);

describe("API client management", () => {
  it("creates a client and shows its key once", async () => {
    const response = await h.owner("POST", "/api/api-clients", {
      name: "Blog backend",
      workspaceId: h.workspaceId,
      grants: [
        { channelId: facebookId, access: "publish" },
        { channelId: instagramId, access: "read" },
      ],
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { client: unknown; secret: string };
    expect(body.secret).toMatch(API_KEY_RE);
    const client = ApiClientSchema.parse(body.client);
    expect(client).toMatchObject({
      name: "Blog backend",
      workspaceId: h.workspaceId,
      workspaceName: "API posts",
      revokedAt: null,
      lastUsedAt: null,
    });
    expect(body.secret.startsWith(client.prefix)).toBe(true);
    expect(client.grants).toEqual(
      expect.arrayContaining([
        {
          channelId: facebookId,
          access: "publish",
          platform: "facebook",
          channelName: "facebook channel",
        },
        {
          channelId: instagramId,
          access: "read",
          platform: "instagram",
          channelName: "instagram channel",
        },
      ]),
    );

    const listed = ListSchema.parse(await (await h.owner("GET", "/api/api-clients")).json());
    const found = listed.items.find((item) => item.id === client.id);
    expect(found).toEqual(client);
    expect(JSON.stringify(listed)).not.toContain(body.secret);

    // The key is in no audit row, and MCP token lists never show API clients.
    const rows = await h.testDb.db.select().from(auditLog).where(eq(auditLog.targetId, client.id));
    expect(rows.map((row) => row.action)).toEqual(["api_client.created"]);
    expect(JSON.stringify(rows)).not.toContain(body.secret);
    const tokens = (await (await h.owner("GET", "/api/tokens")).json()) as {
      items: { id: string }[];
    };
    expect(tokens.items.map((token) => token.id)).not.toContain(client.id);
  });

  it("refuses admins", async () => {
    const asAdmin = (method: string, path: string, body?: unknown) =>
      send(h.t.app, method, path, { cookie: adminCookie, body });
    const { client } = await h.createClient([{ channelId: facebookId, access: "read" }]);
    const cases: [string, string, unknown][] = [
      ["GET", "/api/api-clients", undefined],
      [
        "POST",
        "/api/api-clients",
        {
          name: "x",
          workspaceId: h.workspaceId,
          grants: [{ channelId: facebookId, access: "read" }],
        },
      ],
      ["PATCH", `/api/api-clients/${client.id}`, { name: "renamed" }],
      ["DELETE", `/api/api-clients/${client.id}`, undefined],
    ];
    for (const [method, path, body] of cases) {
      const response = await asAdmin(method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await errorCode(response)).toBe("forbidden");
    }
  });

  it("validates the workspace, the grants and the expiry", async () => {
    const base = { name: "Bad", workspaceId: h.workspaceId };
    const unknownChannel = await h.owner("POST", "/api/api-clients", {
      ...base,
      grants: [
        { channelId: facebookId, access: "read" },
        { channelId: randomUUID(), access: "write" },
      ],
    });
    expect(unknownChannel.status).toBe(400);
    const body = (await unknownChannel.json()) as { error: { details: { path: string }[] } };
    expect(body.error.details.map((issue) => issue.path)).toEqual(["grants.1.channelId"]);

    const twice = await h.owner("POST", "/api/api-clients", {
      ...base,
      grants: [
        { channelId: facebookId, access: "read" },
        { channelId: facebookId, access: "write" },
      ],
    });
    expect(twice.status).toBe(400);
    const none = await h.owner("POST", "/api/api-clients", { ...base, grants: [] });
    expect(none.status).toBe(400);
    const unknownWorkspace = await h.owner("POST", "/api/api-clients", {
      ...base,
      workspaceId: randomUUID(),
      grants: [{ channelId: facebookId, access: "read" }],
    });
    expect(unknownWorkspace.status).toBe(404);
    const past = await h.owner("POST", "/api/api-clients", {
      ...base,
      grants: [{ channelId: facebookId, access: "read" }],
      expiresAt: new Date(h.t.clock.now().getTime() - 1_000).toISOString(),
    });
    expect(past.status).toBe(400);

    const [archived] = await h.testDb.db
      .insert(workspaces)
      .values({
        slug: `old-${randomUUID().slice(0, 8)}`,
        name: "Old",
        status: "archived",
        createdBy: h.ownerId,
      })
      .returning();
    const toArchived = await h.owner("POST", "/api/api-clients", {
      ...base,
      workspaceId: archived?.id,
      grants: [{ channelId: facebookId, access: "read" }],
    });
    expect(toArchived.status).toBe(409);
  });

  it("grants only channels of the client's workspace", async () => {
    const other = await insertWorkspace(h.testDb.db, { createdBy: h.ownerId, name: "Other" });
    const foreign = (
      await insertChannel(h.testDb.db, keyring, { workspaceId: other, platform: "facebook" })
    ).id;
    const refused = await h.owner("POST", "/api/api-clients", {
      name: "Cross",
      workspaceId: h.workspaceId,
      grants: [
        { channelId: facebookId, access: "read" },
        { channelId: foreign, access: "publish" },
      ],
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "validation_failed",
        details: [
          { path: "grants.1.channelId", message: "No channel of this workspace has that id" },
        ],
      },
    });

    // Nor may a change of grants reach into another workspace.
    const { client } = await h.createClient([{ channelId: facebookId, access: "read" }]);
    const changed = await h.owner("PATCH", `/api/api-clients/${client.id}`, {
      grants: [{ channelId: foreign, access: "read" }],
    });
    expect(changed.status).toBe(400);
    expect(await errorCode(changed)).toBe("validation_failed");
    const [listed] = (
      (await (await h.owner("GET", "/api/api-clients")).json()) as {
        items: { id: string; grants: { channelId: string }[] }[];
      }
    ).items.filter((item) => item.id === client.id);
    expect(listed?.grants.map((grant) => grant.channelId)).toEqual([facebookId]);
  });

  it("changes grants for the client's next request", async () => {
    const { client, secret } = await h.createClient([{ channelId: facebookId, access: "read" }]);
    const before = (await (await machine(h.t, secret, "GET", "/api/v1/channels")).json()) as {
      items: { id: string; access: string }[];
    };
    expect(before.items.map((channel) => [channel.id, channel.access])).toEqual([
      [facebookId, "read"],
    ]);

    const updated = await h.owner("PATCH", `/api/api-clients/${client.id}`, {
      name: "Renamed",
      grants: [
        { channelId: instagramId, access: "write" },
        { channelId: facebookId, access: "publish" },
      ],
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(ApiClientSchema.parse(await updated.json()).name).toBe("Renamed");

    const after = (await (await machine(h.t, secret, "GET", "/api/v1/channels")).json()) as {
      items: { id: string; access: string }[];
    };
    expect(new Map(after.items.map((channel) => [channel.id, channel.access]))).toEqual(
      new Map([
        [facebookId, "publish"],
        [instagramId, "write"],
      ]),
    );
    const audited = await h.testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, client.id));
    expect(audited.map((row) => row.action)).toContain("api_client.updated");

    const missing = await h.owner("PATCH", `/api/api-clients/${randomUUID()}`, { name: "x" });
    expect(missing.status).toBe(404);
  });

  it("revokes a client, which stops its key at once", async () => {
    const { client, secret } = await h.createClient([{ channelId: facebookId, access: "read" }]);
    expect((await machine(h.t, secret, "GET", "/api/v1/me")).status).toBe(200);

    const revoked = await h.owner("DELETE", `/api/api-clients/${client.id}`);
    expect(revoked.status).toBe(204);
    const refused = await machine(h.t, secret, "GET", "/api/v1/me");
    expect(refused.status).toBe(401);
    expect(await errorCode(refused)).toBe("unauthorized");

    // Revoking again changes nothing; a revoked client keeps its grants but cannot change.
    expect((await h.owner("DELETE", `/api/api-clients/${client.id}`)).status).toBe(204);
    const rename = await h.owner("PATCH", `/api/api-clients/${client.id}`, { name: "x" });
    expect(rename.status).toBe(409);
    const listed = ListSchema.parse(await (await h.owner("GET", "/api/api-clients")).json());
    expect(listed.items.find((item) => item.id === client.id)?.revokedAt).not.toBeNull();
    const audited = await h.testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, client.id));
    expect(audited.filter((row) => row.action === "api_client.revoked")).toHaveLength(1);
  });
});
