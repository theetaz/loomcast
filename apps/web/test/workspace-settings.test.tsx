import { channelPicturePath } from "@loomcast/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockChannel } from "@/mocks/calendar";
import { createMockDb, mockWorkspace } from "@/mocks/db";
import { onlineStudio, recordRequests } from "./support/kb";
import { renderApp } from "./support/render";

const SLUG = "unfolded";
const SETTINGS = `/w/${SLUG}/settings`;
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";

function setup() {
  const workspace = mockWorkspace({ name: "Unfolded", slug: SLUG, timeZone: "Europe/London" });
  const other = mockWorkspace({ name: "Maths is beautiful", slug: "maths" });
  const page = mockChannel({
    workspaceId: workspace.id,
    platform: "facebook",
    displayName: "Unfolded Page",
    connected: true,
    status: "active",
  });
  page.pictureUrl = channelPicturePath(page.id, "1");
  const planning = mockChannel({
    workspaceId: workspace.id,
    platform: "instagram",
    displayName: "@unfolded",
  });
  const elsewhere = mockChannel({
    workspaceId: other.id,
    platform: "instagram",
    displayName: "@maths",
  });
  elsewhere.pictureUrl = channelPicturePath(elsewhere.id, "1");
  const db = createMockDb({
    signedIn: true,
    workspaces: [workspace, other],
    devices: [onlineStudio()],
    channels: [page, planning, elsewhere],
  });
  return { db, workspace, page };
}

/** Stands in for the browser's image decoding and canvas, which jsdom lacks. */
function stubCanvas() {
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 512, height: 300, close })),
  );
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ drawImage, imageSmoothingQuality: "low" }) as unknown as CanvasRenderingContext2D,
  );
  const toDataURL = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue(`data:image/png;base64,${PNG_BASE64}`);
  return { drawImage, toDataURL, close };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workspace settings", () => {
  it("opens on General, with Channels and API clients beside it", async () => {
    const { db } = setup();
    renderApp(SETTINGS, db);

    const tabs = await screen.findByRole("tablist", { name: "Workspace settings sections" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["General", "Channels", "API clients"]);
    expect(within(tabs).getByRole("tab", { name: "General" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue("Unfolded");
  });

  it("saves the colour", async () => {
    const { db, workspace } = setup();
    const requests = recordRequests();
    const { user } = renderApp(SETTINGS, db);

    const ember = await screen.findByRole("radio", { name: "Ember" });
    expect(screen.getByRole("radio", { name: "Thread" })).toBeChecked();
    await user.click(ember);

    await waitFor(() =>
      expect(db.workspaces.find((entry) => entry.id === workspace.id)?.color).toBe("ember"),
    );
    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.path).toBe(`/api/workspaces/${workspace.id}`);
    expect(patch?.body).toEqual({ color: "ember" });
    expect(await screen.findByText("Colour saved")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Ember" })).toBeChecked();
  });

  it("saves the time zone picked from the searchable list", async () => {
    const { db, workspace } = setup();
    const requests = recordRequests();
    const { user } = renderApp(SETTINGS, db);

    const zone = await screen.findByRole("combobox", { name: "Time zone" });
    expect(zone).toHaveValue("Europe/London");
    await user.click(zone);
    await user.keyboard("colombo");
    expect(await screen.findByRole("option", { name: "Asia/Colombo" })).toBeInTheDocument();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(db.workspaces.find((entry) => entry.id === workspace.id)?.timeZone).toBe(
        "Asia/Colombo",
      ),
    );
    expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({
      timeZone: "Asia/Colombo",
    });
    expect(await screen.findByText("Time zone saved")).toBeInTheDocument();
  });

  it("resizes an uploaded image to a square PNG and saves it as the icon", async () => {
    const { db, workspace } = setup();
    const canvas = stubCanvas();
    const requests = recordRequests();
    const { user } = renderApp(SETTINGS, db);

    const input = await screen.findByLabelText("Icon image");
    expect(input).toHaveAttribute("accept", "image/png,image/jpeg,image/webp");
    await user.upload(input, new File(["not really a png"], "logo.png", { type: "image/png" }));

    expect(await screen.findByText("Icon saved")).toBeInTheDocument();
    const put = requests.find((request) => request.method === "PUT");
    expect(put?.path).toBe(`/api/workspaces/${workspace.id}/icon`);
    expect(put?.body).toEqual({ mime: "image/png", data: PNG_BASE64 });
    // The centre square of the 512×300 image, drawn at 256×256.
    expect(canvas.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      106,
      0,
      300,
      300,
      0,
      0,
      256,
      256,
    );
    expect(canvas.toDataURL).toHaveBeenCalledWith("image/png");
    expect(canvas.close).toHaveBeenCalled();
    expect(db.workspaces.find((entry) => entry.id === workspace.id)?.iconUrl).toBe(
      `/api/workspaces/${workspace.id}/icon?v=1`,
    );

    await user.click(await screen.findByRole("button", { name: "Remove icon" }));
    await waitFor(() =>
      expect(db.workspaces.find((entry) => entry.id === workspace.id)?.iconUrl).toBeNull(),
    );
    expect(requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("copies a channel's profile picture, offering only this workspace's channels with one", async () => {
    const { db, workspace, page } = setup();
    const requests = recordRequests();
    const { user } = renderApp(SETTINGS, db);

    const button = await screen.findByRole("button", { name: /Use a channel's picture/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Unfolded Page (Facebook)"]);
    await user.click(within(menu).getByRole("menuitem", { name: /Unfolded Page/ }));

    expect(await screen.findByText("Icon saved")).toBeInTheDocument();
    const put = requests.find((request) => request.method === "PUT");
    expect(put?.path).toBe(`/api/workspaces/${workspace.id}/icon`);
    expect(put?.body).toEqual({ fromChannelId: page.id });
  });

  it("shows why the API refused an icon", async () => {
    const { db } = setup();
    stubCanvas();
    const { user } = renderApp(SETTINGS, db, [
      http.put("*/api/workspaces/:id/icon", () =>
        HttpResponse.json(
          { error: { code: "invalid_icon", message: "The icon is larger than 256 KB." } },
          { status: 422 },
        ),
      ),
    ]);

    await user.upload(
      await screen.findByLabelText("Icon image"),
      new File(["png"], "big.png", { type: "image/png" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("The icon is larger than 256 KB.");
  });
});
