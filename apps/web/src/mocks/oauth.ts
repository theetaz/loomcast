import {
  AcceptConnectionSchema,
  type ApiError,
  type CandidateAccount,
  type Channel,
  candidateAccountId,
  OAUTH_CONNECT_PAGE_PATH,
  OAUTH_CONNECTION_TTL_MS,
  type OAuthConnectError,
  type OAuthProvider,
  OAuthProviderSchema,
  type Platform,
  routes,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import { channelView, mockChannel } from "./calendar";
import { type MockDb, mockId, publish } from "./db";

// Connecting channels, following the oauth and channels modules of the API: `oauth.start` makes a
// pending connection at once (no platform sign-in) and redirects to the connect page,
// `oauth.connection` lists its accounts, `oauth.accept` connects the chosen ones (parents
// included) once, `channels.disconnect` wipes a channel's access and `system.features` reports
// the X flag.

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

/** An account a mock sign-in offers, before `alreadyConnected` is worked out on read. */
export type MockCandidate = Omit<CandidateAccount, "alreadyConnected">;

/** A pending connection of the mock API: the accounts a sign-in can publish as. */
export interface MockOAuthConnection {
  id: string;
  provider: OAuthProvider;
  expiresAt: string;
  accounts: MockCandidate[];
  consumedAt: string | null;
}

function apiError(status: number, code: string, message: string, details?: unknown) {
  return HttpResponse.json<ApiError>(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");

/** A candidate account; its id is built from the platform and the platform's id. */
export function mockCandidate(
  platform: Platform,
  externalId: string,
  name: string,
  extra: { username?: string; parent?: MockCandidate } = {},
): MockCandidate {
  return {
    id: candidateAccountId(platform, externalId),
    platform,
    externalId,
    name,
    ...(extra.username === undefined ? {} : { username: extra.username }),
    parentId: extra.parent?.id ?? null,
  };
}

/**
 * The accounts each provider's demo sign-in offers. The Rust Page and Threads profile match the
 * demo channels, so they show as already connected; the rest are new.
 */
export function demoCandidates(provider: OAuthProvider): MockCandidate[] {
  switch (provider) {
    case "meta": {
      const rust = mockCandidate("facebook", "100000000000001", "Rust in 60 seconds");
      const agents = mockCandidate("facebook", "100000000000003", "Agents for small teams");
      return [
        rust,
        mockCandidate("instagram", "178400000000001", "Rust in 60 seconds", {
          username: "rustin60",
          parent: rust,
        }),
        agents,
        mockCandidate("instagram", "178400000000003", "Agents for small teams", {
          username: "agents.smallteams",
          parent: agents,
        }),
      ];
    }
    case "threads":
      return [mockCandidate("threads", "200000000000002", "rustin60", { username: "rustin60" })];
    case "x":
      return [
        mockCandidate("x", "300000000000001", "Rust in 60 seconds", { username: "rustin60" }),
      ];
  }
}

/** Adds a pending connection with `accounts`, as a finished sign-in would. */
export function addMockConnection(
  db: MockDb,
  provider: OAuthProvider,
  accounts: MockCandidate[] = demoCandidates(provider),
  { now = Date.now() }: { now?: number } = {},
): MockOAuthConnection {
  const connection: MockOAuthConnection = {
    id: mockId(),
    provider,
    expiresAt: new Date(now + OAUTH_CONNECTION_TTL_MS).toISOString(),
    accounts,
    consumedAt: null,
  };
  db.oauthConnections = [...(db.oauthConnections ?? []), connection];
  return connection;
}

function connectPage(
  provider: OAuthProvider,
  outcome: { connection: string } | { error: OAuthConnectError },
) {
  const search = new URLSearchParams(
    "connection" in outcome ? { connection: outcome.connection } : { error: outcome.error },
  );
  search.set("provider", provider);
  return `${OAUTH_CONNECT_PAGE_PATH}?${search.toString()}`;
}

/** Whether the mock server can use `provider`: X only behind its flag. */
function usable(db: MockDb, provider: OAuthProvider): boolean {
  return provider !== "x" || db.features?.xPublishing === true;
}

/**
 * What `oauth.start` at `url` ends on, as the connect page's path: a new pending connection for a
 * provider the server can use, `not_configured` otherwise. Mock mode calls it instead of leaving
 * the page, since a page load would reset the mock data.
 */
export function mockOAuthStart(db: MockDb, url: string): string {
  const match = new URL(url, "http://mock.invalid").pathname.match(/\/api\/oauth\/([^/]+)\/start$/);
  const provider = OAuthProviderSchema.safeParse(match?.[1]);
  if (!provider.success) return "/workspaces";
  if (!usable(db, provider.data)) return connectPage(provider.data, { error: "not_configured" });
  const connection = addMockConnection(db, provider.data);
  return connectPage(provider.data, { connection: connection.id });
}

function pending(db: MockDb, id: string) {
  const connection = db.oauthConnections?.find((entry) => entry.id === id);
  if (!connection) return { error: apiError(404, "not_found", "No sign-in has that id.") };
  if (connection.consumedAt !== null || Date.parse(connection.expiresAt) <= Date.now()) {
    return {
      error: apiError(410, "connection_expired", "This sign-in has expired or was already used."),
    };
  }
  return { connection };
}

/** The chosen accounts and their parents, parents first, like the API's `withParents`. */
function withParents(accounts: readonly MockCandidate[], ids: readonly string[]): MockCandidate[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const chosen = new Set<string>();
  for (const id of ids) {
    let current = byId.get(id);
    while (current) {
      chosen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  const depth = (account: MockCandidate) => (account.parentId === null ? 0 : 1);
  return accounts.filter((account) => chosen.has(account.id)).sort((a, b) => depth(a) - depth(b));
}

function touch(channel: Channel) {
  channel.updatedAt = new Date(
    Math.max(Date.now(), Date.parse(channel.updatedAt) + 1),
  ).toISOString();
}

function emit(db: MockDb, channel: Channel): Channel {
  const view = channelView(db, channel);
  publish(db, { type: "channel.updated", payload: { channel: view } });
  return view;
}

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60_000;

export function createOAuthHandlers(db: MockDb) {
  return [
    http.get(path("system.features"), () =>
      db.signedIn
        ? HttpResponse.json({ xPublishing: db.features?.xPublishing ?? false })
        : unauthorized(),
    ),

    http.get(path("oauth.start"), ({ request }) => {
      if (!db.signedIn) return unauthorized();
      return new HttpResponse(null, {
        status: 302,
        headers: { Location: mockOAuthStart(db, request.url) },
      });
    }),

    http.get(path("oauth.connection"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const { connection, error } = pending(db, String(params.id));
      if (error) return error;
      const known = new Set(
        db.channels.flatMap((channel) =>
          channel.externalId === null
            ? []
            : [candidateAccountId(channel.platform, channel.externalId)],
        ),
      );
      return HttpResponse.json({
        id: connection.id,
        provider: connection.provider,
        expiresAt: connection.expiresAt,
        accounts: connection.accounts.map((account) => ({
          ...account,
          alreadyConnected: known.has(account.id),
        })),
      });
    }),

    http.post(path("oauth.accept"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const parsed = AcceptConnectionSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return apiError(400, "validation_failed", "The request is not valid.");
      }
      const { connection, error } = pending(db, String(params.id));
      if (error) return error;
      const workspace = db.workspaces.find((entry) => entry.id === parsed.data.workspaceId);
      if (!workspace) {
        return apiError(400, "validation_failed", "The request is not valid.", [
          { path: "workspaceId", message: "No workspace has that id" },
        ]);
      }
      const known = new Set(connection.accounts.map((account) => account.id));
      const unknown = parsed.data.accountIds.flatMap((id, index) =>
        known.has(id)
          ? []
          : [{ path: `accountIds.${index}`, message: "No account of this connection has that id" }],
      );
      if (unknown.length > 0) {
        return apiError(400, "validation_failed", "The request is not valid.", unknown);
      }
      const chosen = withParents(connection.accounts, parsed.data.accountIds);
      // An account belongs to one workspace: connecting it elsewhere is refused, not moved.
      for (const account of chosen) {
        const elsewhere = db.channels.find(
          (entry) =>
            entry.platform === account.platform &&
            entry.externalId === account.externalId &&
            entry.workspaceId !== workspace.id,
        );
        const owner = elsewhere
          ? db.workspaces.find((entry) => entry.id === elsewhere.workspaceId)
          : undefined;
        if (elsewhere) {
          return apiError(
            409,
            "channel_in_other_workspace",
            `${account.name} is already connected in another workspace.`,
            {
              workspaceId: elsewhere.workspaceId,
              workspaceName: owner?.name ?? "another workspace",
            },
          );
        }
      }
      connection.consumedAt = new Date().toISOString();

      const channelIds = new Map<string, string>();
      const connected: Channel[] = [];
      const tokenExpiresAt =
        connection.provider === "meta" ? null : new Date(Date.now() + SIXTY_DAYS_MS).toISOString();
      for (const account of chosen) {
        const parentChannelId =
          account.parentId === null ? null : (channelIds.get(account.parentId) ?? null);
        const values = {
          username: account.username ?? null,
          parentChannelId,
          connected: true,
          scopes: ["publish"],
          tokenExpiresAt,
          lastVerifiedAt: new Date().toISOString(),
          lastError: null,
        } satisfies Partial<Channel>;
        let channel = db.channels.find(
          (entry) => entry.platform === account.platform && entry.externalId === account.externalId,
        );
        if (channel) {
          // A reconnect keeps the name and the dry-run switch as the user left them.
          Object.assign(channel, values, {
            status: channel.status === "disabled" ? "disabled" : "active",
          } satisfies Partial<Channel>);
          touch(channel);
        } else {
          channel = mockChannel({
            workspaceId: workspace.id,
            platform: account.platform,
            displayName: account.name,
            externalId: account.externalId,
            status: "active",
            ...values,
          });
          db.channels.push(channel);
        }
        channelIds.set(account.id, channel.id);
        connected.push(emit(db, channel));
      }
      return HttpResponse.json({ channels: connected });
    }),

    http.delete(path("channels.disconnect"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const channel = db.channels.find((entry) => entry.id === params.id);
      if (!channel) return apiError(404, "not_found", "No channel has that id.");
      Object.assign(channel, {
        connected: false,
        status: channel.status === "disabled" ? "disabled" : "disconnected",
        dryRun: true,
        scopes: [],
        tokenExpiresAt: null,
        lastError: null,
      } satisfies Partial<Channel>);
      touch(channel);
      return HttpResponse.json(emit(db, channel));
    }),
  ];
}
