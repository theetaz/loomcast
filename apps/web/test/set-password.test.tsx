import type { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { readPasswordToken } from "@/features/members/password-link";
import { createMockDb, type MockDb } from "@/mocks/db";
import { issuePasswordToken, mockMember, mockPasswordToken } from "@/mocks/users";
import { currentPath, renderApp } from "./support/render";
import { server } from "./support/server";

/** Built at runtime, so no credential-like literal lives in the tests. */
function newPassword(): string {
  return ["pw", crypto.randomUUID()].join("-");
}

function setup(purpose: "invite" | "reset" = "invite") {
  const member = mockMember({ email: "ana@example.test", name: "Ana Silva" });
  const db = createMockDb({ members: [member] });
  const link = issuePasswordToken(db, member.id, purpose);
  return { db, member, link };
}

function cacheContents(queryClient: QueryClient): string {
  return JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => ({ key: query.queryKey, state: query.state })),
  );
}

function recordRequests(db: MockDb) {
  const bodies: unknown[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname.startsWith("/api/auth/")) {
      bodies.push(await request.clone().json());
    }
  });
  return { bodies, db };
}

describe("readPasswordToken", () => {
  it("reads a well-formed token from the fragment only", () => {
    const token = mockPasswordToken();
    expect(readPasswordToken(`#token=${token}`)).toBe(token);
    expect(readPasswordToken(`token=${token}`)).toBe(token);
    expect(readPasswordToken("")).toBeNull();
    expect(readPasswordToken("#token=")).toBeNull();
    expect(readPasswordToken("#token=short")).toBeNull();
    expect(readPasswordToken(`#token=${token}!`)).toBeNull();
  });
});

describe("set-password page", () => {
  it("strips the token from the URL and history, then shows who the link is for", async () => {
    const { db, link } = setup();
    const { router, history, queryClient } = renderApp(`/set-password#token=${link.token}`, db);

    // Cleared before the page even asks who the link is for.
    await waitFor(() => expect(history.location.hash).toBe(""));
    expect(history.location.href).toBe("/set-password");
    expect(history.length).toBe(1);
    expect(router.state.location.href).not.toContain(link.token);

    expect(await screen.findByRole("heading", { name: "Join Loomcast" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("ana@example.test");
    expect(screen.getByLabelText("Email")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("New password")).toHaveFocus();
    expect(history.location.href).toBe("/set-password");
    expect(cacheContents(queryClient)).not.toContain(link.token);
  });

  it("takes over a second link opened in the same tab", async () => {
    const { db, link } = setup();
    const other = mockMember({ email: "mei@example.test", name: "Mei Lin" });
    db.members.push(other);
    const second = issuePasswordToken(db, other.id, "reset");
    const { history } = renderApp(`/set-password#token=${link.token}`, db);

    await screen.findByRole("heading", { name: "Join Loomcast" });
    act(() => history.push(`/set-password#token=${second.token}`));

    expect(
      await screen.findByRole("heading", { name: "Choose a new password" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("mei@example.test");
    await waitFor(() => expect(history.location.hash).toBe(""));
  });

  it("sets the password and sends the user to sign in", async () => {
    const { db, link } = setup("reset");
    const { bodies } = recordRequests(db);
    const { user, router, queryClient } = renderApp(`/set-password#token=${link.token}`, db);
    const password = newPassword();

    expect(
      await screen.findByRole("heading", { name: "Choose a new password" }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("New password"), password);
    await user.type(screen.getByLabelText("Confirm password"), password);
    await user.click(screen.getByRole("button", { name: "Set password" }));

    await waitFor(() => expect(currentPath(router)).toBe("/login"));
    expect(await screen.findByText("Password set")).toBeInTheDocument();
    expect(link.usedAt).not.toBeNull();
    expect(bodies).toEqual([{ token: link.token }, { token: link.token, newPassword: password }]);
    // Nothing secret is cached on the way out.
    const cache = cacheContents(queryClient);
    expect(cache).not.toContain(link.token);
    expect(cache).not.toContain(password);
  });

  it("asks for a long enough password and a matching confirmation", async () => {
    const { db, link } = setup();
    const { user } = renderApp(`/set-password#token=${link.token}`, db);
    const password = newPassword();

    await screen.findByRole("heading", { name: "Join Loomcast" });
    await user.type(screen.getByLabelText("New password"), password.slice(0, 11));
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(screen.getByText("Use at least 12 characters.")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveFocus();

    await user.clear(screen.getByLabelText("New password"));
    await user.type(screen.getByLabelText("New password"), password);
    await user.type(screen.getByLabelText("Confirm password"), `${password}x`);
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(screen.getByText("The passwords don't match.")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm password")).toHaveFocus();
    expect(link.usedAt).toBeNull();
  });

  it("explains a link that is missing its token", async () => {
    const requests: string[] = [];
    server.events.on("request:start", ({ request }) => {
      requests.push(new URL(request.url).pathname);
    });
    renderApp("/set-password", createMockDb());

    expect(await screen.findByText("This link is incomplete")).toBeInTheDocument();
    expect(requests).not.toContain("/api/auth/password-tokens/inspect");
  });

  it("explains an expired link", async () => {
    const { db, link } = setup();
    link.expiresAt = new Date(Date.now() - 60_000).toISOString();
    const { history } = renderApp(`/set-password#token=${link.token}`, db);

    expect(
      await screen.findByText("This link has expired or was already used"),
    ).toBeInTheDocument();
    expect(history.location.hash).toBe("");
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("explains a used link, including one used while the page was open", async () => {
    const { db, link } = setup();
    const { user } = renderApp(`/set-password#token=${link.token}`, db);
    const password = newPassword();

    await screen.findByRole("heading", { name: "Join Loomcast" });
    link.usedAt = new Date().toISOString();
    await user.type(screen.getByLabelText("New password"), password);
    await user.type(screen.getByLabelText("Confirm password"), password);
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect(
      await screen.findByText("This link has expired or was already used"),
    ).toBeInTheDocument();
  });

  it("asks to wait when there were too many attempts, then retries", async () => {
    const { db, link } = setup();
    let limited = true;
    const { user } = renderApp(`/set-password#token=${link.token}`, db, [
      http.post("*/api/auth/password-tokens/inspect", () =>
        limited
          ? HttpResponse.json(
              { error: { code: "rate_limited", message: "Too many requests." } },
              { status: 429, headers: { "Retry-After": "60" } },
            )
          : undefined,
      ),
    ]);

    expect(
      await screen.findByText("Too many attempts. Wait a minute and try again."),
    ).toBeInTheDocument();
    limited = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Join Loomcast" })).toBeInTheDocument();
  });

  it("shows a rate limit on submit inline and keeps the form", async () => {
    const { db, link } = setup();
    const { user } = renderApp(`/set-password#token=${link.token}`, db, [
      http.post("*/api/auth/set-password", () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "Too many requests." } },
          { status: 429 },
        ),
      ),
    ]);
    const password = newPassword();

    await screen.findByRole("heading", { name: "Join Loomcast" });
    await user.type(screen.getByLabelText("New password"), password);
    await user.type(screen.getByLabelText("Confirm password"), password);
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Wait a minute and try again.",
    );
    expect(screen.getByLabelText("New password")).toHaveValue(password);
    expect(link.usedAt).toBeNull();
  });
});
