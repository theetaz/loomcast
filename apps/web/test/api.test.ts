import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createApiClient,
  errorMessage,
  INVALID_RESPONSE,
  NETWORK_ERROR,
} from "@/lib/api";
import { mockProject } from "@/mocks/db";
import { server } from "./support/server";

const project = mockProject({ name: "Rust in 60 seconds", slug: "rust-in-60-seconds" });

describe("api client", () => {
  const client = createApiClient();
  afterEach(() => client.setUnauthorizedHandler(null));

  it("fills path parameters and parses the response with the route schema", async () => {
    let seen: Request | undefined;
    server.use(
      http.get("*/api/projects/:idOrSlug", ({ request }) => {
        seen = request;
        return HttpResponse.json({ ...project, extra: "ignored" });
      }),
    );

    const result = await client.request("projects.get", { params: { idOrSlug: "a b" } });

    expect(result).toEqual(project);
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/projects/a%20b");
    expect(seen?.credentials).toBe("same-origin");
    expect(seen?.headers.get("content-type")).toBe("application/json");
  });

  it("sends the body as JSON and adds defined query values", async () => {
    let body: unknown;
    let url: URL | undefined;
    server.use(
      http.post("*/api/projects", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(project, { status: 201 });
      }),
      http.get("*/api/projects", ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ items: [] });
      }),
    );

    await client.request("projects.create", { body: { name: "Rust in 60 seconds" } });
    await client.request("projects.list", { query: { status: "archived" } });

    expect(body).toEqual({ name: "Rust in 60 seconds" });
    expect(url?.searchParams.get("status")).toBe("archived");
  });

  it("resolves 204 routes to undefined", async () => {
    server.use(http.post("*/api/auth/logout", () => new HttpResponse(null, { status: 204 })));
    await expect(client.request("auth.logout")).resolves.toBeUndefined();
  });

  it("turns an error body into an ApiError", async () => {
    server.use(
      http.post("*/api/projects", () =>
        HttpResponse.json(
          { error: { code: "conflict", message: "That slug is taken.", details: { slug: "x" } } },
          { status: 409 },
        ),
      ),
    );

    const error = await client.request("projects.create", { body: { name: "x" } }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "conflict", details: { slug: "x" } });
    expect(errorMessage(error)).toBe("That slug is taken.");
  });

  it("reports responses without an error body, bad bodies and network failures", async () => {
    server.use(
      http.get("*/api/devices", () => new HttpResponse("<html>", { status: 502 })),
      http.get("*/api/auth/me", () => HttpResponse.json({ id: "not-a-user" })),
      http.get("*/api/tokens", () => HttpResponse.error()),
    );

    await expect(client.request("devices.list")).rejects.toMatchObject({
      status: 502,
      code: "http_error",
    });
    await expect(client.request("auth.me")).rejects.toMatchObject({ code: INVALID_RESPONSE });
    const offline = await client.request("tokens.list").catch((e) => e);
    expect(offline).toMatchObject({ status: 0, code: NETWORK_ERROR });
    expect(errorMessage(offline)).toMatch(/can't reach loomcast/i);
  });

  it("calls the unauthorized handler for session routes only, unless told not to", async () => {
    server.use(
      http.get("*/api/projects", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "No session" } },
          { status: 401 },
        ),
      ),
      http.get("*/api/auth/me", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "No session" } },
          { status: 401 },
        ),
      ),
      http.post("*/api/auth/login", () =>
        HttpResponse.json(
          { error: { code: "invalid_credentials", message: "No" } },
          { status: 401 },
        ),
      ),
    );
    const handler = vi.fn();
    client.setUnauthorizedHandler(handler);

    await expect(client.request("projects.list")).rejects.toMatchObject({ status: 401 });
    await expect(
      client.request("auth.me", { redirectOnUnauthorized: false }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      client.request("auth.login", { body: { email: "a@b.co", password: "x" } }),
    ).rejects.toMatchObject({ status: 401 });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
