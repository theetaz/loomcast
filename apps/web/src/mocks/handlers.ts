import {
  type ApiError,
  CreateTokenRequestSchema,
  type CreateTokenResponse,
  CreateWorkspaceSchema,
  LIVE_STREAM_PATH,
  type LiveEvent,
  LoginRequestSchema,
  routes,
  SetWorkspaceIconSchema,
  slugify,
  UpdateWorkspaceSchema,
  type Workspace,
} from "@loomcast/contracts";
import { HttpResponse, http, sse } from "msw";
import { createAnalyticsHandlers } from "./analytics";
import { createApiClientHandlers } from "./api-clients";
import { createApprovalHandlers } from "./approvals";
import { createCalendarHandlers } from "./calendar";
import { createChannelHandlers } from "./channels";
import { createCompetitorHandlers } from "./competitors";
import { createContentHandlers } from "./content";
import { createContentItemHandlers } from "./content-item";
import { createConversationHandlers } from "./conversations";
import {
  type MockDb,
  type MockWorkspaceIcon,
  mockPairingCode,
  mockToken,
  mockTokenSecret,
  mockWorkspace,
  pairMockDevice,
  publish,
  setSignedIn,
  tokenPrefix,
} from "./db";
import { createFormatHandlers } from "./formats";
import { createKbHandlers } from "./kb";
import { createOAuthHandlers } from "./oauth";
import { createReviewQueueHandlers } from "./review-queue";
import { createSchedulerHandlers } from "./scheduler";
import { createSeriesHandlers } from "./series";
import { createUploadHandlers } from "./uploads";
import { createUserHandlers } from "./users";

/** Hono paths (`:id`) and MSW paths share the same syntax. */
const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");

function uniqueSlug(db: MockDb, base: string): string {
  const root = base || "workspace";
  const taken = new Set(db.workspaces.map((workspace) => workspace.slug));
  if (!taken.has(root)) return root;
  let n = 2;
  while (taken.has(`${root}-${n}`)) n += 1;
  return `${root}-${n}`;
}

function findWorkspace(db: MockDb, idOrSlug: string): Workspace | undefined {
  return db.workspaces.find(
    (workspace) => workspace.id === idOrSlug || workspace.slug === idOrSlug,
  );
}

/** A 1×1 PNG, standing in for a channel's profile picture. */
const MOCK_PICTURE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Stores or removes a workspace's icon; its URL changes with every new image, like the API's. */
function saveIcon(db: MockDb, workspace: Workspace, icon: MockWorkspaceIcon | null): Workspace {
  db.workspaceIcons ??= {};
  const icons = db.workspaceIcons;
  if (icon) {
    const version = (icons[workspace.id]?.version ?? 0) + 1;
    icons[workspace.id] = { ...icon, version };
    workspace.iconUrl = `/api/workspaces/${workspace.id}/icon?v=${version}`;
  } else {
    delete icons[workspace.id];
    workspace.iconUrl = null;
  }
  workspace.updatedAt = new Date().toISOString();
  publish(db, { type: "workspace.updated", payload: { workspace: { ...workspace } } });
  return { ...workspace };
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

    http.get(path("workspaces.list"), () =>
      db.signedIn ? HttpResponse.json({ items: db.workspaces }) : unauthorized(),
    ),

    http.post(path("workspaces.create"), async ({ request }) => {
      if (!db.signedIn) return unauthorized();
      const parsed = CreateWorkspaceSchema.safeParse(await request.json());
      if (!parsed.success) return apiError(400, "validation_failed", "Check the workspace name.");
      const { name, slug, description, color, timeZone } = parsed.data;
      const workspace = mockWorkspace({
        name,
        slug: uniqueSlug(db, slug ?? slugify(name)),
        description: description || null,
        ...(color ? { color } : {}),
        ...(timeZone ? { timeZone } : {}),
      });
      db.workspaces.unshift(workspace);
      publish(db, { type: "workspace.created", payload: { workspace } });
      return HttpResponse.json(workspace, { status: 201 });
    }),

    http.get(path("workspaces.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const workspace = findWorkspace(db, String(params.idOrSlug));
      return workspace
        ? HttpResponse.json(workspace)
        : apiError(404, "not_found", "No workspace has that id or slug.");
    }),

    http.patch(path("workspaces.update"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const workspace = findWorkspace(db, String(params.idOrSlug));
      if (!workspace) return apiError(404, "not_found", "No workspace has that id or slug.");
      const parsed = UpdateWorkspaceSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success)
        return apiError(400, "validation_failed", "Check the workspace details.");
      const { name, description, color, timeZone } = parsed.data;
      if (name !== undefined) workspace.name = name;
      if (description !== undefined) workspace.description = description || null;
      if (color !== undefined) workspace.color = color;
      if (timeZone !== undefined) workspace.timeZone = timeZone;
      workspace.updatedAt = new Date().toISOString();
      publish(db, { type: "workspace.updated", payload: { workspace: { ...workspace } } });
      return HttpResponse.json(workspace);
    }),

    http.post(path("workspaces.archive"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const workspace = db.workspaces.find((item) => item.id === params.id);
      if (!workspace) return apiError(404, "not_found", "No workspace has that id.");
      if (workspace.status !== "archived") {
        const now = new Date().toISOString();
        workspace.status = "archived";
        workspace.archivedAt = now;
        workspace.updatedAt = now;
        publish(db, { type: "workspace.updated", payload: { workspace: { ...workspace } } });
      }
      return HttpResponse.json(workspace);
    }),

    http.get(path("workspaces.icon"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const icon = db.workspaceIcons?.[String(params.id)];
      if (!icon) return apiError(404, "not_found", "The workspace has no icon.");
      const bytes = Uint8Array.from(atob(icon.data), (char) => char.charCodeAt(0));
      return new HttpResponse(bytes, { headers: { "Content-Type": icon.mime } });
    }),

    http.put(path("workspaces.setIcon"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const workspace = db.workspaces.find((item) => item.id === params.id);
      if (!workspace) return apiError(404, "not_found", "No workspace has that id.");
      const parsed = SetWorkspaceIconSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return apiError(422, "invalid_icon", "Use a PNG, JPEG or WebP image of at most 256 KB.");
      }
      let icon: MockWorkspaceIcon;
      if ("fromChannelId" in parsed.data) {
        const { fromChannelId } = parsed.data;
        const channel = db.channels.find(
          (entry) => entry.id === fromChannelId && entry.workspaceId === workspace.id,
        );
        if (!channel?.pictureUrl) {
          return apiError(422, "invalid_icon", "That channel of the workspace has no picture.");
        }
        icon = { mime: "image/png", data: MOCK_PICTURE_PNG };
      } else {
        icon = parsed.data;
      }
      return HttpResponse.json(saveIcon(db, workspace, icon));
    }),

    http.delete(path("workspaces.clearIcon"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const workspace = db.workspaces.find((item) => item.id === params.id);
      if (!workspace) return apiError(404, "not_found", "No workspace has that id.");
      return HttpResponse.json(saveIcon(db, workspace, null));
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

    ...createApiClientHandlers(db),
    ...createConversationHandlers(db),
    ...createKbHandlers(db),
    ...createUserHandlers(db),
    ...createContentHandlers(db),
    ...createFormatHandlers(db),
    ...createSeriesHandlers(db),
    ...createReviewQueueHandlers(db),
    ...createUploadHandlers(db),
    ...createCalendarHandlers(db),
    ...createAnalyticsHandlers(db),
    ...createChannelHandlers(db),
    ...createApprovalHandlers(db),
    ...createSchedulerHandlers(db),
    ...createOAuthHandlers(db),
    ...createCompetitorHandlers(db),
    // Last, so handlers added for the same routes elsewhere take precedence.
    ...createContentItemHandlers(db),
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
