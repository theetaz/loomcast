import { PASSWORD_TOKEN_RE } from "@loomcast/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createMockDb, MOCK_USER } from "@/mocks/db";
import { mockMember } from "@/mocks/users";
import { renderApp } from "./support/render";
import { server } from "./support/server";

function members() {
  return [
    mockMember({
      email: "kasun@example.test",
      name: "Kasun Fernando",
      lastLoginAt: "2026-10-12T09:00:00.000Z",
    }),
    mockMember({ email: "mei@example.test", name: "Mei Lin" }),
    mockMember({
      email: "jonas@example.test",
      name: "Jonas Becker",
      lastLoginAt: "2026-08-01T09:00:00.000Z",
      disabledAt: "2026-09-01T09:00:00.000Z",
    }),
  ];
}

function signedInDb(role: "owner" | "admin" = "owner", list = members()) {
  return createMockDb({ signedIn: true, user: { ...MOCK_USER, role }, members: list });
}

/** Everything TanStack Query holds: query data and mutation state. */
function cacheContents(queryClient: QueryClient): string {
  return JSON.stringify({
    queries: queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state),
    mutations: queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  });
}

function tokenOf(url: string): string {
  return new URL(url).hash.replace(/^#token=/, "");
}

describe("members list", () => {
  it("lists members with role, last sign-in and status, the owner first", async () => {
    renderApp("/settings/members", signedInDb());

    const table = await screen.findByRole("table", { name: "Members" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.querySelector("td")?.textContent)).toEqual([
      `NP${MOCK_USER.name}(you)${MOCK_USER.email}`,
      "KFKasun Fernandokasun@example.test",
      "MLMei Linmei@example.test",
      "JBJonas Beckerjonas@example.test",
    ]);
    const [owner, kasun, mei, jonas] = rows as HTMLElement[];
    expect(within(owner as HTMLElement).getByText("Owner")).toBeInTheDocument();
    expect(within(kasun as HTMLElement).getByText("Admin")).toBeInTheDocument();
    expect(within(kasun as HTMLElement).getByText("Active")).toBeInTheDocument();
    expect(kasun?.querySelector("time")).toHaveAttribute("datetime", "2026-10-12T09:00:00.000Z");
    expect(within(mei as HTMLElement).getByText("Invited")).toBeInTheDocument();
    expect(within(mei as HTMLElement).getByText("Never")).toBeInTheDocument();
    expect(within(jonas as HTMLElement).getByText("Disabled")).toBeInTheDocument();

    // Only other, enabled members can be managed.
    expect(screen.queryByRole("button", { name: `Manage ${MOCK_USER.name}` })).toBeNull();
    expect(screen.getByRole("button", { name: "Manage Kasun Fernando" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage Jonas Becker" })).toBeNull();
  });

  it("shows the Members tab to the owner and hides it from admins", async () => {
    const owner = renderApp("/settings/devices", signedInDb());
    const ownerTabs = await screen.findByRole("tablist", { name: "Settings sections" });
    expect(
      within(ownerTabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Devices", "Access tokens", "Members"]);
    owner.unmount();

    const requests: string[] = [];
    server.events.on("request:start", ({ request }) => {
      requests.push(new URL(request.url).pathname);
    });
    renderApp("/settings/members", signedInDb("admin"));
    expect(await screen.findByText("Only the owner manages members")).toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "Settings sections" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Devices", "Access tokens"]);
    expect(requests).not.toContain("/api/users");
  });

  it("shows the error and retries", async () => {
    let fail = true;
    const { user } = renderApp("/settings/members", signedInDb(), [
      http.get("*/api/users", () =>
        fail
          ? HttpResponse.json({ error: { code: "internal", message: "Boom" } }, { status: 500 })
          : undefined,
      ),
    ]);

    expect(await screen.findByText("Couldn't load members")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Members" })).toBeInTheDocument();
  });
});

describe("invitations", () => {
  it("shows the link once, then keeps it out of the page and every cache", async () => {
    const db = signedInDb("owner", []);
    const posted: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/api/users/invitations") {
        posted.push(await request.clone().json());
      }
    });
    const { user, queryClient } = renderApp("/settings/members", db);

    expect(await screen.findByText("It's just you so far")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite a member" });
    await user.type(within(dialog).getByLabelText("Email"), "Ana@Example.test");
    await user.type(within(dialog).getByLabelText("Name"), "Ana Silva");
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));

    const reveal = await screen.findByRole("dialog", { name: "Send the invitation link" });
    expect(posted).toEqual([{ email: "ana@example.test", name: "Ana Silva", role: "admin" }]);
    const link = within(reveal).getByTestId("password-link").textContent ?? "";
    expect(link.startsWith(`${window.location.origin}/set-password#token=`)).toBe(true);
    expect(tokenOf(link)).toMatch(PASSWORD_TOKEN_RE);
    expect(db.passwordTokens.at(-1)?.token).toBe(tokenOf(link));
    expect(within(reveal).getByText("This is the only time it's shown.")).toBeInTheDocument();
    expect(within(reveal).getByText(/7 days from now/)).toBeInTheDocument();
    expect(reveal.querySelector("time")).toHaveAttribute(
      "datetime",
      db.passwordTokens.at(-1)?.expiresAt,
    );

    await user.click(within(reveal).getByRole("button", { name: /copy link/i }));
    expect(await navigator.clipboard.readText()).toBe(link);

    // Even while the reveal is open, the link is in no query or mutation cache.
    await waitFor(() => expect(cacheContents(queryClient)).not.toContain(tokenOf(link)));

    await user.click(within(reveal).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(tokenOf(link));
    expect(cacheContents(queryClient)).not.toContain(tokenOf(link));

    // The new member is listed, pending until they sign in.
    const table = await screen.findByRole("table", { name: "Members" });
    const row = within(table).getByText("Ana Silva").closest("tr") as HTMLElement;
    expect(within(row).getByText("Invited")).toBeInTheDocument();

    // Opening again starts over: an empty form, no link.
    await user.click(screen.getByRole("button", { name: "Invite member" }));
    const again = await screen.findByRole("dialog", { name: "Invite a member" });
    expect(within(again).getByLabelText("Email")).toHaveValue("");
    expect(document.body.textContent).not.toContain(tokenOf(link));
  });

  it("clears the link when the dialog is closed with Escape", async () => {
    const { user, queryClient } = renderApp("/settings/members", signedInDb());

    await user.click(await screen.findByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite a member" });
    await user.type(within(dialog).getByLabelText("Email"), "ana@example.test");
    await user.type(within(dialog).getByLabelText("Name"), "Ana Silva");
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    const reveal = await screen.findByRole("dialog", { name: "Send the invitation link" });
    const token = tokenOf(within(reveal).getByTestId("password-link").textContent ?? "");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(token);
    expect(cacheContents(queryClient)).not.toContain(token);
  });

  it("checks the form and explains a taken email", async () => {
    const db = signedInDb();
    const { user } = renderApp("/settings/members", db);

    await user.click(await screen.findByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite a member" });
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    expect(within(dialog).getByText(/Enter an email address/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Add their name/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Email")).toHaveFocus();

    await user.type(within(dialog).getByLabelText("Email"), "kasun@example.test");
    await user.type(within(dialog).getByLabelText("Name"), "Kasun again");
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    expect(
      await within(dialog).findByText("Someone with this email is already a member."),
    ).toBeInTheDocument();
    expect(db.members).toHaveLength(3);
    expect(db.passwordTokens).toHaveLength(0);
  });
});

describe("managing a member", () => {
  it("creates a reset link after confirming, shown once", async () => {
    const db = signedInDb();
    const { user, queryClient } = renderApp("/settings/members", db);

    await user.click(await screen.findByRole("button", { name: "Manage Kasun Fernando" }));
    await user.click(await screen.findByRole("menuitem", { name: "New password link" }));
    const dialog = await screen.findByRole("dialog", {
      name: "New password link for Kasun Fernando?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Create link" }));

    const reveal = await screen.findByRole("dialog", { name: "Send the reset link" });
    const link = within(reveal).getByTestId("password-link").textContent ?? "";
    expect(db.passwordTokens.at(-1)).toMatchObject({
      token: tokenOf(link),
      purpose: "reset",
      userId: db.members[0]?.id,
    });
    expect(within(reveal).getByText(/24 hours from now/)).toBeInTheDocument();

    await user.click(within(reveal).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(tokenOf(link));
    expect(cacheContents(queryClient)).not.toContain(tokenOf(link));
  });

  it("disables a member after confirming", async () => {
    const db = signedInDb();
    const { user } = renderApp("/settings/members", db);

    await user.click(await screen.findByRole("button", { name: "Manage Mei Lin" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disable access" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Disable Mei Lin?" });
    await user.click(within(confirm).getByRole("button", { name: "Disable access" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(db.members[1]?.disabledAt).not.toBeNull();
    expect(await screen.findByText("Access disabled")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Members" });
    const row = within(table).getByText("Mei Lin").closest("tr") as HTMLElement;
    expect(within(row).getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage Mei Lin" })).toBeNull();
  });

  it("keeps the confirmation open with the reason when disabling fails", async () => {
    const { user } = renderApp("/settings/members", signedInDb(), [
      http.post("*/api/users/:id/disable", () =>
        HttpResponse.json(
          { error: { code: "conflict", message: "The owner's account cannot be disabled." } },
          { status: 409 },
        ),
      ),
    ]);

    await user.click(await screen.findByRole("button", { name: "Manage Kasun Fernando" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disable access" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Disable Kasun Fernando?" });
    await user.click(within(confirm).getByRole("button", { name: "Disable access" }));

    expect(
      await within(confirm).findByText("The owner's account cannot be disabled."),
    ).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
