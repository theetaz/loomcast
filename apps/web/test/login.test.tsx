import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createMockDb, MOCK_PASSWORD, MOCK_USER, mockProject } from "@/mocks/db";
import { currentPath, renderApp } from "./support/render";
import { server } from "./support/server";

function seededDb() {
  return createMockDb({
    projects: [mockProject({ name: "Rust in 60 seconds", slug: "rust-in-60-seconds" })],
  });
}

describe("login", () => {
  it("submits with Enter and redirects to the requested page", async () => {
    const db = seededDb();
    let body: unknown;
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login") {
        body = await request.clone().json();
      }
    });
    const { user, router } = renderApp("/login?next=%2Fprojects", db);

    await user.type(await screen.findByLabelText("Email"), ` ${MOCK_USER.email} `);
    await user.type(screen.getByLabelText("Password"), `${MOCK_PASSWORD}{Enter}`);

    expect(await screen.findByRole("link", { name: /rust in 60 seconds/i })).toBeInTheDocument();
    expect(currentPath(router)).toBe("/projects");
    expect(body).toEqual({ email: MOCK_USER.email, password: MOCK_PASSWORD });
    expect(db.signedIn).toBe(true);
  });

  it("goes home when next points off-site", async () => {
    const { user, router } = renderApp("/login?next=https%3A%2F%2Fevil.example", seededDb());

    await user.type(await screen.findByLabelText("Email"), MOCK_USER.email);
    await user.type(screen.getByLabelText("Password"), MOCK_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: /good .*, nadia/i })).toBeInTheDocument();
    expect(currentPath(router)).toBe("/");
  });

  it("explains wrong credentials inline and clears the password", async () => {
    const { user } = renderApp("/login", seededDb());

    await user.type(await screen.findByLabelText("Email"), MOCK_USER.email);
    await user.type(screen.getByLabelText("Password"), "not-the-password{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/i);
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveFocus();
  });

  it("validates empty fields without calling the API", async () => {
    let calls = 0;
    const { user } = renderApp("/login", seededDb(), [
      http.post("*/api/auth/login", () => {
        calls += 1;
        return HttpResponse.json({});
      }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Sign in" }));

    expect(screen.getByText("Enter your email address.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(calls).toBe(0);
  });

  it("skips the form for a signed-in user", async () => {
    const db = seededDb();
    db.signedIn = true;
    const { router } = renderApp("/login?next=%2Fprojects", db);

    await waitFor(() => expect(currentPath(router)).toBe("/projects"));
  });
});
