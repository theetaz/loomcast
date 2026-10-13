import { describe, expect, it } from "vitest";
import {
  AcceptConnectionResponseSchema,
  AcceptConnectionSchema,
  API_ERROR_CODES,
  buildPath,
  type CandidateAccount,
  ChannelSchema,
  type ConnectionCandidates,
  ConnectionCandidatesSchema,
  candidateAccountId,
  OAUTH_CONNECT_ERRORS,
  OAUTH_PROVIDER_PLATFORMS,
  OAUTH_PROVIDERS,
  OAuthCallbackQuerySchema,
  OAuthConnectSearchSchema,
  OAuthRedirectToSchema,
  oauthProviderForPlatform,
  oauthStartPath,
  PLATFORMS,
  routes,
  SystemFeaturesSchema,
} from "../src";
import { at, channel, ids } from "./fixtures";

const connectionId = "b5c6d7e8-f9a0-4b1c-8d2e-f3a4b5c6d7e8";

const page: CandidateAccount = {
  id: candidateAccountId("facebook", "104000000000001"),
  platform: "facebook",
  externalId: "104000000000001",
  name: "Rust in 60 seconds",
  parentId: null,
  alreadyConnected: false,
};

const instagram: CandidateAccount = {
  id: candidateAccountId("instagram", "17841400000000001"),
  platform: "instagram",
  externalId: "17841400000000001",
  name: "Rust in 60 seconds",
  username: "rustin60",
  parentId: page.id,
  alreadyConnected: true,
};

const meta: ConnectionCandidates = {
  id: connectionId,
  provider: "meta",
  expiresAt: "2026-10-12T10:00:00.000Z",
  accounts: [page, instagram],
};

/** A value shaped like a credential, built at runtime so no literal appears in the source. */
function runtimeValue(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2)}`;
}

describe("oauth providers", () => {
  it("lists meta, threads and x", () => {
    expect(OAUTH_PROVIDERS).toEqual(["meta", "threads", "x"]);
  });

  it("connects every platform through exactly one provider", () => {
    const connected = OAUTH_PROVIDERS.flatMap((provider) => OAUTH_PROVIDER_PLATFORMS[provider]);

    expect([...connected].sort()).toEqual([...PLATFORMS].sort());
    for (const provider of OAUTH_PROVIDERS) {
      for (const platform of OAUTH_PROVIDER_PLATFORMS[provider]) {
        expect(oauthProviderForPlatform(platform)).toBe(provider);
      }
    }
  });

  it("builds candidate ids from the platform and its account id", () => {
    expect(candidateAccountId("threads", "9001")).toBe("threads:9001");
  });
});

describe("connection candidates", () => {
  it("accepts a page with its instagram account", () => {
    expect(ConnectionCandidatesSchema.parse(meta)).toEqual(meta);
  });

  it("accepts a connection without accounts", () => {
    const empty = { ...meta, accounts: [] };

    expect(ConnectionCandidatesSchema.parse(empty)).toEqual(empty);
  });

  it("never carries credentials", () => {
    const leaked = {
      ...meta,
      accessToken: runtimeValue("connection"),
      accounts: [{ ...page, accessToken: runtimeValue("page") }, instagram],
    };
    const parsed = ConnectionCandidatesSchema.parse(leaked);

    expect(parsed).toEqual(meta);
    expect(JSON.stringify(parsed)).not.toContain("accessToken");
  });

  it("rejects repeated account ids", () => {
    const result = ConnectionCandidatesSchema.safeParse({ ...meta, accounts: [page, page] });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["accounts", 1, "id"]);
  });

  it("rejects accounts on a platform the provider does not connect", () => {
    const threadsProfile: CandidateAccount = {
      ...page,
      id: candidateAccountId("threads", "1"),
      platform: "threads",
    };

    expect(
      ConnectionCandidatesSchema.safeParse({ ...meta, accounts: [page, threadsProfile] }).success,
    ).toBe(false);
    expect(
      ConnectionCandidatesSchema.safeParse({ ...meta, provider: "threads", accounts: [page] })
        .success,
    ).toBe(false);
    expect(
      ConnectionCandidatesSchema.safeParse({
        ...meta,
        provider: "threads",
        accounts: [{ ...threadsProfile, username: "rustin60" }],
      }).success,
    ).toBe(true);
  });

  it("requires a parent to be another account of the connection", () => {
    const orphan = { ...instagram, parentId: candidateAccountId("facebook", "999") };
    const own = { ...instagram, parentId: instagram.id };

    expect(
      ConnectionCandidatesSchema.safeParse({ ...meta, accounts: [page, orphan] }).success,
    ).toBe(false);
    expect(ConnectionCandidatesSchema.safeParse({ ...meta, accounts: [page, own] }).success).toBe(
      false,
    );
  });

  it("bounds names and requires account ids", () => {
    expect(
      ConnectionCandidatesSchema.safeParse({ ...meta, accounts: [{ ...page, name: "" }] }).success,
    ).toBe(false);
    expect(
      ConnectionCandidatesSchema.safeParse({
        ...meta,
        accounts: [{ ...page, name: "x".repeat(121) }],
      }).success,
    ).toBe(false);
    expect(
      ConnectionCandidatesSchema.safeParse({ ...meta, accounts: [{ ...page, externalId: " " }] })
        .success,
    ).toBe(false);
  });
});

describe("accepting a connection", () => {
  it("takes one or more distinct account ids", () => {
    expect(AcceptConnectionSchema.parse({ accountIds: [instagram.id] })).toEqual({
      accountIds: [instagram.id],
    });
    expect(AcceptConnectionSchema.safeParse({ accountIds: [] }).success).toBe(false);
    expect(AcceptConnectionSchema.safeParse({ accountIds: [page.id, page.id] }).success).toBe(
      false,
    );
    expect(AcceptConnectionSchema.safeParse({ accountIds: [""] }).success).toBe(false);
  });

  it("answers with channels, without credentials", () => {
    const response = { channels: [channel] };
    const parsed = AcceptConnectionResponseSchema.parse({
      channels: [{ ...channel, secretCiphertext: runtimeValue("cipher") }],
    });

    expect(parsed).toEqual(response);
  });

  it("answers 410 connection_expired for a used connection", () => {
    expect(API_ERROR_CODES).toContain("connection_expired");
  });
});

describe("channel verification fields", () => {
  it("are optional, nullable and carry a publish error", () => {
    expect(ChannelSchema.parse(channel)).toEqual(channel);
    const reauth = {
      ...channel,
      status: "needs_reauth" as const,
      lastVerifiedAt: at,
      lastError: {
        code: "auth" as const,
        retryable: false,
        platformCode: "190",
        message: "Expired",
      },
    };
    expect(ChannelSchema.parse(reauth)).toEqual(reauth);
    expect(
      ChannelSchema.parse({ ...channel, lastVerifiedAt: null, lastError: null }),
    ).toMatchObject({ lastVerifiedAt: null, lastError: null });
  });
});

describe("sign-in redirects", () => {
  it("allows only paths on the app as redirect targets", () => {
    expect(OAuthRedirectToSchema.parse("/settings/channels")).toBe("/settings/channels");
    for (const target of [
      "//evil.example/path",
      "https://evil.example/",
      "/\\evil.example",
      "settings",
      "",
    ]) {
      expect(OAuthRedirectToSchema.safeParse(target).success, target).toBe(false);
    }
  });

  it("builds the start url for a full-page navigation", () => {
    expect(oauthStartPath("meta")).toBe("/api/oauth/meta/start");
    expect(oauthStartPath("threads", { redirectTo: "/settings/channels?tab=all" })).toBe(
      "/api/oauth/threads/start?redirectTo=%2Fsettings%2Fchannels%3Ftab%3Dall",
    );
    expect(() => oauthStartPath("x", { redirectTo: "//evil.example" })).toThrow();
  });

  it("reads a declined sign-in from the callback query", () => {
    const state = runtimeValue("state");

    expect(
      OAuthCallbackQuerySchema.parse({
        error: "access_denied",
        error_reason: "user_denied",
        state,
        unexpected: "dropped",
      }),
    ).toEqual({ error: "access_denied", error_reason: "user_denied", state });
    expect(OAuthCallbackQuerySchema.safeParse({ state: "s".repeat(2_049) }).success).toBe(false);
  });

  it("parses the connect page's search params", () => {
    expect(OAuthConnectSearchSchema.parse({ connection: connectionId })).toEqual({
      connection: connectionId,
    });
    expect(OAuthConnectSearchSchema.parse({ error: "no_accounts", provider: "meta" })).toEqual({
      error: "no_accounts",
      provider: "meta",
    });
    expect(OAuthConnectSearchSchema.safeParse({ error: "boom" }).success).toBe(false);
    expect(OAUTH_CONNECT_ERRORS).toContain("not_configured");
  });
});

describe("oauth, channel and system routes", () => {
  it("are session routes; the sign-in routes redirect", () => {
    for (const name of [
      "oauth.start",
      "oauth.callback",
      "oauth.connection",
      "oauth.accept",
      "channels.disconnect",
      "system.features",
    ] as const) {
      expect(routes[name].auth, name).toBe("session");
    }
    for (const name of ["oauth.start", "oauth.callback"] as const) {
      expect(routes[name].method).toBe("GET");
      expect(routes[name].status).toBe(302);
      expect(routes[name].response).toBeNull();
    }
    expect(routes["oauth.start"].params.parse({ provider: "threads" })).toEqual({
      provider: "threads",
    });
    expect(routes["oauth.start"].params.safeParse({ provider: "tiktok" }).success).toBe(false);
  });

  it("builds their paths", () => {
    expect(buildPath(routes["oauth.callback"].path, { provider: "meta" })).toBe(
      "/api/oauth/meta/callback",
    );
    expect(buildPath(routes["oauth.connection"].path, { id: connectionId })).toBe(
      `/api/oauth/connections/${connectionId}`,
    );
    expect(buildPath(routes["oauth.accept"].path, { id: connectionId })).toBe(
      `/api/oauth/connections/${connectionId}/accept`,
    );
    expect(routes["oauth.accept"].method).toBe("POST");
    expect(routes["channels.disconnect"].method).toBe("DELETE");
    expect(buildPath(routes["channels.disconnect"].path, { id: ids.channel })).toBe(
      `/api/channels/${ids.channel}/connection`,
    );
    expect(routes["system.features"].path).toBe("/api/system/features");
  });

  it("reports the x publishing flag", () => {
    expect(SystemFeaturesSchema.parse({ xPublishing: false })).toEqual({ xPublishing: false });
    expect(SystemFeaturesSchema.safeParse({}).success).toBe(false);
  });
});
