import {
  type ApiError,
  CreateProjectSchema,
  CreateTokenRequestSchema,
  type CreateTokenResponse,
  LIVE_STREAM_PATH,
  type LiveEvent,
  LoginRequestSchema,
  type Project,
  routes,
  slugify,
} from "@loomcast/contracts";
import { HttpResponse, http, sse } from "msw";
import { createConversationHandlers } from "./conversations";
import {
  type MockDb,
  mockPairingCode,
  mockProject,
  mockToken,
  mockTokenSecret,
  pairMockDevice,
  publish,
  setSignedIn,
  tokenPrefix,
} from "./db";

/** Hono paths (`:id`) and MSW paths share the same syntax. */
const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");

function uniqueSlug(db: MockDb, base: string): string {
  const root = base || "project";
  const taken = new Set(db.projects.map((project) => project.slug));
  if (!taken.has(root)) return root;
  let n = 2;
  while (taken.has(`${root}-${n}`)) n += 1;
  return `${root}-${n}`;
}

function findProject(db: MockDb, idOrSlug: string): Project | undefined {
  return db.projects.find((project) => project.id === idOrSlug || project.slug === idOrSlug);
}

/**
 * Handlers for the routes the shell uses, following `@loomcast/contracts`. They
 * read and write `db`, so a test can arrange state and assert on it afterwards.
 */
export function createHandlers(db: MockDb) {
  return [
    http.post(path("auth.login"), async ({ request }) => {
      const parsed = LoginRequestSchema.safeParse(await request.json());
      if (!parsed.success)
        return apiError(400, "validation_failed", "Check the email and password.");
      if (parsed.data.email !== db.user.email || parsed.data.password !== db.password) {
        return apiError(401, "invalid_credentials", "Email or password is incorrect.");
      }
      setSignedIn(db, true);
      return HttpResponse.json(db.user);
    }),

    http.post(path("auth.logout"), () => {
      setSignedIn(db, false);
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(path("auth.me"), () => (db.signedIn ? HttpResponse.json(db.user) : unauthorized())),

    http.get(path("projects.list"), () =>
      db.signedIn ? HttpResponse.json({ items: db.projects }) : unauthorized(),
    ),

    http.post(path("projects.create"), async ({ request }) => {
      if (!db.signedIn) return unauthorized();
      const parsed = CreateProjectSchema.safeParse(await request.json());
      if (!parsed.success) return apiError(400, "validation_failed", "Check the project name.");
      const { name, slug, description } = parsed.data;
      const project = mockProject({
        name,
        slug: uniqueSlug(db, slug ?? slugify(name)),
        description: description || null,
      });
      db.projects.unshift(project);
      publish(db, { type: "project.created", payload: { project } });
      return HttpResponse.json(project, { status: 201 });
    }),

    http.get(path("projects.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const project = findProject(db, String(params.idOrSlug));
      return project
        ? HttpResponse.json(project)
        : apiError(404, "not_found", "No project has that id or slug.");
    }),

    http.get(path("devices.list"), () =>
      db.signedIn ? HttpResponse.json({ items: db.devices }) : unauthorized(),
    ),

    http.post(path("devices.createPairingCode"), () => {
      if (!db.signedIn) return unauthorized();
      const pairing = mockPairingCode();
      db.pairingCodes.push(pairing);
      if (db.autoPairAfterMs !== undefined) {
        setTimeout(() => {
          if (db.pairingCodes.at(-1)?.code === pairing.code) pairMockDevice(db);
        }, db.autoPairAfterMs);
      }
      return HttpResponse.json(pairing, { status: 201 });
    }),

    http.delete(path("devices.revoke"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const device = db.devices.find((item) => item.id === params.id && item.revokedAt === null);
      if (!device) return apiError(404, "not_found", "No device has that id.");
      device.revokedAt = new Date().toISOString();
      if (device.online) {
        device.online = false;
        publish(db, {
          type: "device.status",
          payload: { deviceId: device.id, online: false, lastSeenAt: device.lastSeenAt },
        });
      }
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(path("tokens.list"), () =>
      db.signedIn ? HttpResponse.json({ items: db.tokens }) : unauthorized(),
    ),

    http.post(path("tokens.create"), async ({ request }) => {
      if (!db.signedIn) return unauthorized();
      const parsed = CreateTokenRequestSchema.safeParse(await request.json());
      if (!parsed.success) {
        return apiError(400, "validation_failed", "Check the token name and scopes.");
      }
      const { name, scopes, expiresAt } = parsed.data;
      if (scopes.includes("mcp:admin") && db.user.role !== "owner") {
        return apiError(403, "forbidden", "Only the owner can create admin tokens.");
      }
      const secret = mockTokenSecret();
      const token = mockToken({
        name,
        scopes,
        prefix: tokenPrefix(secret),
        expiresAt: expiresAt ?? null,
      });
      db.tokens.unshift(token);
      const body: CreateTokenResponse = { token, secret };
      return HttpResponse.json(body, { status: 201 });
    }),

    http.delete(path("tokens.revoke"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const token = db.tokens.find((item) => item.id === params.id && item.revokedAt === null);
      if (!token) return apiError(404, "not_found", "No token has that id.");
      token.revokedAt = new Date().toISOString();
      return new HttpResponse(null, { status: 204 });
    }),

    ...createConversationHandlers(db),
  ];
}

/**
 * The live stream, publishing what the handlers above change. Browser only:
 * MSW needs `EventSource` to build it, and jsdom has none.
 */
export function createStreamHandler(db: MockDb) {
  return sse(`*${LIVE_STREAM_PATH}`, ({ client, request }) => {
    if (!db.signedIn) {
      client.error();
      return;
    }
    const send = (event: LiveEvent) => client.send({ data: JSON.stringify(event) });
    db.listeners.add(send);
    request.signal.addEventListener("abort", () => db.listeners.delete(send));
  });
}
