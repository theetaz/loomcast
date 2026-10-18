import {
  type ApiChannelGrant,
  type ApiClient,
  type ApiError,
  CreateApiClientRequestSchema,
  type CreateApiClientResponse,
  routes,
  TOKEN_PREFIXES,
  TOKEN_SECRET_LENGTH,
  UpdateApiClientRequestSchema,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import { type MockDb, mockId } from "./db";

// The owner's API clients, following `@loomcast/contracts`. Keys are generated per request and
// never kept: the list holds only their prefixes.

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A key shaped like a real API client's. */
export function mockApiKey(): string {
  const random = Array.from(
    { length: TOKEN_SECRET_LENGTH },
    () => BASE62[Math.floor(Math.random() * BASE62.length)] ?? "0",
  ).join("");
  return `${TOKEN_PREFIXES.api}${random}`;
}

/** The listed part of a key: its kind prefix and the first characters. */
export function apiKeyPrefix(secret: string): string {
  return secret.slice(0, TOKEN_PREFIXES.api.length + 8);
}

export function mockApiClient(
  overrides: Partial<ApiClient> & Pick<ApiClient, "name" | "projectId" | "projectName">,
): ApiClient {
  return {
    id: mockId(),
    prefix: apiKeyPrefix(mockApiKey()),
    grants: [],
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function grantsView(db: MockDb, grants: readonly ApiChannelGrant[]): ApiClient["grants"] | null {
  const view: ApiClient["grants"] = [];
  for (const grant of grants) {
    const channel = db.channels.find((item) => item.id === grant.channelId);
    if (!channel) return null;
    view.push({ ...grant, platform: channel.platform, channelName: channel.displayName });
  }
  return view;
}

export function createApiClientHandlers(db: MockDb) {
  const guard = () => {
    if (!db.signedIn) return apiError(401, "unauthorized", "Sign in to continue.");
    if (db.user.role !== "owner") {
      return apiError(403, "forbidden", "Only the owner can manage API clients.");
    }
    return null;
  };

  return [
    http.get(path("apiClients.list"), () => {
      const refused = guard();
      if (refused) return refused;
      return HttpResponse.json({ items: db.apiClients });
    }),

    http.post(path("apiClients.create"), async ({ request }) => {
      const refused = guard();
      if (refused) return refused;
      const parsed = CreateApiClientRequestSchema.safeParse(await request.json());
      if (!parsed.success) {
        return apiError(400, "validation_failed", "Check the name, project and channels.");
      }
      const project = db.projects.find((item) => item.id === parsed.data.projectId);
      if (!project) return apiError(404, "not_found", "No project has that id.");
      const grants = grantsView(db, parsed.data.grants);
      if (!grants) return apiError(400, "validation_failed", "No channel has that id.");
      const secret = mockApiKey();
      const client = mockApiClient({
        name: parsed.data.name,
        projectId: project.id,
        projectName: project.name,
        prefix: apiKeyPrefix(secret),
        grants,
        expiresAt: parsed.data.expiresAt ?? null,
      });
      db.apiClients.unshift(client);
      const body: CreateApiClientResponse = { client, secret };
      return HttpResponse.json(body, { status: 201, headers: { "Cache-Control": "no-store" } });
    }),

    http.patch(path("apiClients.update"), async ({ params, request }) => {
      const refused = guard();
      if (refused) return refused;
      const client = db.apiClients.find((item) => item.id === params.id);
      if (!client) return apiError(404, "not_found", "No API client has that id.");
      if (client.revokedAt !== null) {
        return apiError(409, "conflict", "This API client is revoked.");
      }
      const parsed = UpdateApiClientRequestSchema.safeParse(await request.json());
      if (!parsed.success)
        return apiError(400, "validation_failed", "Check the name and channels.");
      if (parsed.data.grants) {
        const grants = grantsView(db, parsed.data.grants);
        if (!grants) return apiError(400, "validation_failed", "No channel has that id.");
        client.grants = grants;
      }
      if (parsed.data.name) client.name = parsed.data.name;
      return HttpResponse.json(client);
    }),

    http.delete(path("apiClients.revoke"), ({ params }) => {
      const refused = guard();
      if (refused) return refused;
      const client = db.apiClients.find((item) => item.id === params.id);
      if (!client) return apiError(404, "not_found", "No API client has that id.");
      client.revokedAt ??= new Date().toISOString();
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}
