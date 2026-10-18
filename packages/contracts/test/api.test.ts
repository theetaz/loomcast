import { describe, expect, expectTypeOf, it } from "vitest";
import {
  API_KEY_RE,
  ApiErrorSchema,
  buildPath,
  ChangePasswordRequestSchema,
  CreateTokenRequestSchema,
  CreateTokenResponseSchema,
  CursorPageQuerySchema,
  DEVICE_TOKEN_RE,
  JOB_TOKEN_RE,
  JobTokenSecretSchema,
  LoginRequestSchema,
  MAX_MESSAGE_TEXT_LENGTH,
  MCP_TOKEN_RE,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_RE,
  PairRequestSchema,
  PairResponseSchema,
  type PathParams,
  PostMessageRequestSchema,
  PostMessageResponseSchema,
  type RouteBody,
  type RouteResponse,
  routes,
  TOKEN_KINDS,
  TOKEN_PREFIXES,
  UpdateProjectSchema,
} from "../src";
import { ids, job, message } from "./fixtures";

const secret = (prefix: string) => `${prefix}${"aZ09".repeat(10)}xyz`;

describe("conversation DTOs", () => {
  const clientMessageId = "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918";

  it("accepts a message up to 20,000 characters", () => {
    const text = "x".repeat(MAX_MESSAGE_TEXT_LENGTH);

    expect(PostMessageRequestSchema.parse({ text, clientMessageId })).toEqual({
      text,
      clientMessageId,
    });
  });

  it("rejects over-long, blank and unkeyed messages", () => {
    const text = "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1);

    expect(PostMessageRequestSchema.safeParse({ text, clientMessageId }).success).toBe(false);
    expect(PostMessageRequestSchema.safeParse({ text: " \n\t", clientMessageId }).success).toBe(
      false,
    );
    expect(PostMessageRequestSchema.safeParse({ text: "hi" }).success).toBe(false);
    expect(PostMessageRequestSchema.safeParse({ text: "hi", clientMessageId: "1" }).success).toBe(
      false,
    );
  });

  it("returns the stored message with its job", () => {
    const response = { message, job };

    expect(PostMessageResponseSchema.parse(response)).toEqual(response);
  });
});

describe("auth DTOs", () => {
  it("normalises the login email", () => {
    const login = LoginRequestSchema.parse({ email: "  Owner@Example.TEST ", password: "x" });

    expect(login.email).toBe("owner@example.test");
    expect(LoginRequestSchema.safeParse({ email: "owner", password: "x" }).success).toBe(false);
  });

  it("requires a new password of at least 12 characters", () => {
    const change = (newPassword: string) =>
      ChangePasswordRequestSchema.safeParse({ currentPassword: "old", newPassword }).success;

    expect(change("short-pass1")).toBe(false);
    expect(change("long-enough-1")).toBe(true);
  });
});

describe("project DTOs", () => {
  it("rejects an empty update", () => {
    expect(UpdateProjectSchema.safeParse({}).success).toBe(false);
    expect(UpdateProjectSchema.safeParse({ description: null }).success).toBe(true);
  });
});

describe("device DTOs", () => {
  it("normalises a pairing code typed on the command line", () => {
    const request = PairRequestSchema.parse({
      code: " abcd-efgh ",
      name: "Studio Mac",
      platform: "darwin-arm64",
      agentVersion: "0.1.0",
    });

    expect(request.code).toBe("ABCD-EFGH");
  });

  it("uses a pairing alphabet without look-alike characters", () => {
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[01IO]/);
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32);
    expect(PAIRING_CODE_RE.test("ABCD-EFGH")).toBe(true);
    expect(PAIRING_CODE_RE.test("ABCD-EFG0")).toBe(false);
    expect(PAIRING_CODE_RE.test("ABCDEFGH")).toBe(false);
  });

  it("returns a device token with the device prefix", () => {
    expect(
      PairResponseSchema.safeParse({ deviceId: ids.device, token: secret("lc_dev_") }),
    ).toEqual(expect.objectContaining({ success: true }));
    expect(
      PairResponseSchema.safeParse({ deviceId: ids.device, token: secret("lc_mcp_") }).success,
    ).toBe(false);
  });
});

describe("token DTOs", () => {
  it("accepts only distinct MCP scopes", () => {
    const create = (scopes: string[]) =>
      CreateTokenRequestSchema.safeParse({ name: "Laptop", scopes }).success;

    expect(create(["mcp:read", "mcp:write"])).toBe(true);
    expect(create([])).toBe(false);
    expect(create(["bridge"])).toBe(false);
    expect(create(["mcp:read", "mcp:read"])).toBe(false);
  });

  it("returns the MCP secret once, next to the stored token", () => {
    const token = {
      id: ids.user,
      kind: "mcp",
      name: "Laptop",
      prefix: "lc_mcp_aZ09",
      scopes: ["mcp:read"],
      createdAt: "2026-10-12T09:30:00Z",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    };

    expect(CreateTokenResponseSchema.safeParse({ token, secret: secret("lc_mcp_") }).success).toBe(
      true,
    );
    expect(CreateTokenResponseSchema.safeParse({ token, secret: "lc_mcp_short" }).success).toBe(
      false,
    );
  });
});

describe("token formats", () => {
  const patterns = {
    mcp: MCP_TOKEN_RE,
    device: DEVICE_TOKEN_RE,
    job: JOB_TOKEN_RE,
    api: API_KEY_RE,
  };

  it("has a distinct prefix for every token kind", () => {
    expect(Object.keys(TOKEN_PREFIXES).sort()).toEqual([...TOKEN_KINDS].sort());
    expect(new Set(Object.values(TOKEN_PREFIXES)).size).toBe(TOKEN_KINDS.length);
    expect(TOKEN_PREFIXES.job).toBe("lc_job_");
  });

  it.each(TOKEN_KINDS)("matches only %s tokens with the %s pattern", (kind) => {
    for (const other of TOKEN_KINDS) {
      expect(patterns[kind].test(secret(TOKEN_PREFIXES[other]))).toBe(other === kind);
    }
  });

  it.each([
    ["too short", `lc_job_${"a".repeat(42)}`],
    ["too long", `lc_job_${"a".repeat(44)}`],
    ["not base62", `lc_job_${"a".repeat(42)}-`],
    ["upper-case prefix", `LC_JOB_${"a".repeat(43)}`],
    ["surrounding space", ` lc_job_${"a".repeat(43)}`],
  ])("rejects a job token that is %s", (_name, value) => {
    expect(JobTokenSecretSchema.safeParse(value).success).toBe(false);
  });
});

describe("shared API shapes", () => {
  it("parses error bodies with optional details", () => {
    expect(ApiErrorSchema.parse({ error: { code: "not_found", message: "No project" } })).toEqual({
      error: { code: "not_found", message: "No project" },
    });
    expect(ApiErrorSchema.safeParse({ code: "not_found" }).success).toBe(false);
  });

  it("coerces and bounds the page limit", () => {
    expect(CursorPageQuerySchema.parse({ limit: "25" })).toEqual({ limit: 25 });
    expect(CursorPageQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(CursorPageQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
});

describe("routes", () => {
  const entries = Object.entries(routes);

  it("has one route per method and path", () => {
    const keys = entries.map(([, route]) => `${route.method} ${route.path}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(entries)("%s declares a params schema matching its path", (_name, route) => {
    const pathParams = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    const schemaParams = "params" in route ? Object.keys(route.params.shape) : [];

    expect(schemaParams.sort()).toEqual(pathParams.sort());
    expect(route.path.startsWith("/api/")).toBe(true);
    const bodiless = route.status === 204 || route.status === 302;
    expect(bodiless || ("image" in route && route.image === true)).toBe(route.response === null);
  });

  it("keeps public routes to login, set-password links and device pairing", () => {
    const publicRoutes = entries.filter(([, route]) => route.auth === "none").map(([name]) => name);

    expect(publicRoutes.sort()).toEqual([
      "auth.inspectPasswordToken",
      "auth.login",
      "auth.setPassword",
      "bridge.pair",
    ]);
  });

  it("builds paths with encoded parameters", () => {
    expect(buildPath(routes["messages.post"].path, { id: ids.conversation })).toBe(
      `/api/conversations/${ids.conversation}/messages`,
    );
    expect(buildPath(routes["projects.get"].path, { idOrSlug: "a/b c" })).toBe(
      "/api/projects/a%2Fb%20c",
    );
    expect(buildPath(routes["auth.me"].path, {})).toBe("/api/auth/me");
  });

  it("throws when a path parameter is missing", () => {
    const params = {} as PathParams<"/api/jobs/:id">;

    expect(() => buildPath("/api/jobs/:id", params)).toThrow(/"id"/);
  });

  it("derives request and response types from the map", () => {
    expectTypeOf<RouteBody<"messages.post">>().toEqualTypeOf<{
      text: string;
      clientMessageId: string;
    }>();
    expectTypeOf<RouteBody<"auth.me">>().toEqualTypeOf<undefined>();
    expectTypeOf<RouteResponse<"auth.logout">>().toEqualTypeOf<undefined>();
    expectTypeOf<RouteResponse<"jobs.get">["status"]>().toEqualTypeOf<
      "queued" | "dispatched" | "running" | "succeeded" | "failed" | "cancelled"
    >();
    expectTypeOf<PathParams<"/api/projects/:projectId/conversations">>().toEqualTypeOf<{
      projectId: string;
    }>();
  });
});
