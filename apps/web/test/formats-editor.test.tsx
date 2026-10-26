import type { FormatRules, UpdateFormatRequest } from "@loomcast/contracts";
import { routes } from "@loomcast/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mockId } from "@/mocks/db";
import { recordRequests } from "./support/kb";
import { renderApp } from "./support/render";
import { seriesSetup } from "./support/series";

function formatPath(setup: ReturnType<typeof seriesSetup>) {
  return `/w/${setup.rust.slug}/series/${setup.series.ownership.id}/format`;
}

async function editor() {
  return screen.findByRole("form", { name: "Format rules" }, { timeout: 5000 });
}

function updates(requests: ReturnType<typeof recordRequests>) {
  return requests
    .filter((request) => request.method === "PATCH" && request.path.startsWith("/api/formats/"))
    .map((request) => request.body as UpdateFormatRequest);
}

describe("format editor", () => {
  it("loads the current version and shows the history with a JSON diff", async () => {
    const setup = seriesSetup();
    const { user } = renderApp(formatPath(setup), setup.db);
    const form = await editor();
    expect(within(form).getByLabelText("Name")).toHaveValue("Ownership basics");
    expect(within(form).getByLabelText("Longest (seconds)")).toHaveValue(50);
    expect(within(form).getByLabelText("Voice ID (optional)")).toHaveValue("voice-ava");
    expect(within(form).getByRole("combobox", { name: "Time zone" })).toHaveValue("Europe/London");
    expect(within(form).getByRole("button", { name: "Wednesday" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(form).getByText("Version 2. No unsaved changes.")).toBeInTheDocument();

    const history = screen.getByRole("region", { name: "Version history" });
    await user.click(await within(history).findByRole("button", { name: /Version 2/ }));
    const changes = within(history).getByRole("list", { name: "Changes in version 2" });
    const tz = within(changes).getByText("cadence.tz").closest("li") as HTMLElement;
    expect(within(tz).getByText('"UTC"').tagName).toBe("DEL");
    expect(within(tz).getByText('"Europe/London"').tagName).toBe("INS");
    expect(within(changes).getByText("topicPool")).toBeInTheDocument();
    expect(within(changes).getByText(/"moves"/).tagName).toBe("INS");
  });

  it("shows contract errors on their fields and saves once they are fixed", async () => {
    const setup = seriesSetup();
    const requests = recordRequests();
    const baseVersionId = setup.formats.ownership.currentVersion.id;
    const { user } = renderApp(formatPath(setup), setup.db);
    const form = await editor();

    const shortest = within(form).getByLabelText("Shortest (seconds)");
    await user.clear(shortest);
    await user.type(shortest, "70");
    await user.click(within(form).getByRole("button", { name: "Save version" }));

    const longest = within(form).getByLabelText("Longest (seconds)");
    expect(
      await within(form).findByText("The shortest length must not exceed the longest"),
    ).toBeInTheDocument();
    expect(longest).toHaveAttribute("aria-invalid", "true");
    expect(shortest).not.toHaveAttribute("aria-invalid");
    expect(within(form).getByText("Fix one field to save.")).toBeInTheDocument();
    expect(updates(requests)).toEqual([]);

    await user.clear(shortest);
    await user.type(shortest, "20");
    await waitFor(() => expect(longest).not.toHaveAttribute("aria-invalid"));
    await user.click(within(form).getByRole("button", { name: "Save version" }));

    expect(await screen.findByText("Saved as version 3")).toBeInTheDocument();
    const [update] = updates(requests);
    expect(update?.baseVersionId).toBe(baseVersionId);
    expect(update?.name).toBeUndefined();
    expect(update?.rules?.lengthSec).toEqual({ min: 20, max: 50 });
    expect(
      setup.db.formats.find((format) => format.id === setup.formats.ownership.id)?.currentVersion
        .versionNo,
    ).toBe(3);
    expect(await within(form).findByText("Version 3. No unsaved changes.")).toBeInTheDocument();
    const history = screen.getByRole("region", { name: "Version history" });
    expect(await within(history).findByRole("button", { name: /Version 3/ })).toBeInTheDocument();
  });

  it("edits the cadence: days, times and a searched time zone", async () => {
    const setup = seriesSetup();
    const requests = recordRequests();
    const { user } = renderApp(formatPath(setup), setup.db);
    const form = await editor();

    await user.click(within(form).getByRole("button", { name: "Tuesday" }));
    await user.click(within(form).getByRole("button", { name: "Friday" }));
    expect(within(form).getByRole("button", { name: "Tuesday" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(form).getByRole("button", { name: "Remove time 18:00" }));
    await user.click(within(form).getByRole("button", { name: "Add time" }));
    const added = within(form).getByLabelText("Time 2");
    expect(added).toHaveValue("10:00");
    fireEvent.change(added, { target: { value: "07:15" } });

    const zone = within(form).getByRole("combobox", { name: "Time zone" });
    await user.click(zone);
    await user.type(zone, "new york");
    expect(screen.getByRole("option", { name: "America/New York" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(zone).toHaveValue("America/New_York");

    const lead = within(form).getByLabelText("Lead time (hours)");
    await user.clear(lead);
    await user.type(lead, "48");
    expect(within(form).getByText("2 days before each slot")).toBeInTheDocument();
    expect(within(form).getByRole("list", { name: "Next slots" })).toBeInTheDocument();

    await user.click(within(form).getByRole("button", { name: "Save version" }));
    expect(await screen.findByText("Saved as version 3")).toBeInTheDocument();
    const rules = updates(requests)[0]?.rules as FormatRules;
    expect(rules.cadence).toEqual({
      days: ["mon", "tue", "wed"],
      slots: ["09:00", "07:15"],
      tz: "America/New_York",
      leadTimeHours: 48,
    });
  });

  it("refuses repeated times and an empty lead time before saving", async () => {
    const setup = seriesSetup();
    const requests = recordRequests();
    const { user } = renderApp(formatPath(setup), setup.db);
    const form = await editor();

    fireEvent.change(within(form).getByLabelText("Time 2"), { target: { value: "09:00" } });
    await user.clear(within(form).getByLabelText("Lead time (hours)"));
    await user.click(within(form).getByRole("button", { name: "Save version" }));

    expect(await within(form).findByText("Times must not repeat")).toBeInTheDocument();
    expect(within(form).getByText("Enter a number")).toBeInTheDocument();
    expect(within(form).getByText("Fix 2 fields to save.")).toBeInTheDocument();
    expect(updates(requests)).toEqual([]);
  });

  it("adds topics as chips, one per pasted line", async () => {
    const setup = seriesSetup();
    const requests = recordRequests();
    const { user } = renderApp(formatPath(setup), setup.db);
    const form = await editor();

    const topics = within(form).getByLabelText("Topic pool");
    await user.click(topics);
    await user.paste("lifetimes\n\nslices\nmoves\n");
    await user.type(topics, "Rc and Arc{Enter}");
    expect(within(form).getByRole("list", { name: "5 topics" })).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Remove topic borrowing" }));

    const hashtags = within(form).getByLabelText("Hashtags");
    await user.type(hashtags, "#Programming{Enter}#RUSTLANG{Enter}");
    expect(within(form).getByRole("list", { name: "2 hashtags" })).toBeInTheDocument();

    await user.click(within(form).getByRole("button", { name: "Save version" }));
    expect(await screen.findByText("Saved as version 3")).toBeInTheDocument();
    const rules = updates(requests)[0]?.rules as FormatRules;
    expect(rules.topicPool).toEqual(["moves", "lifetimes", "slices", "Rc and Arc"]);
    expect(rules.caption.hashtags).toEqual(["rustlang", "Programming"]);
  });

  it("puts the API's validation errors on the fields they name", async () => {
    const setup = seriesSetup();
    const override = http.patch(`*${routes["formats.update"].path}`, () =>
      HttpResponse.json(
        {
          error: {
            code: "validation_failed",
            message: "The request is not valid.",
            details: [{ path: "rules.voiceId", message: "No voice has that id" }],
          },
        },
        { status: 400 },
      ),
    );
    const { user } = renderApp(formatPath(setup), setup.db, [override]);
    const form = await editor();
    const voice = within(form).getByLabelText("Voice ID (optional)");
    await user.clear(voice);
    await user.type(voice, "voice-zed");
    await user.click(within(form).getByRole("button", { name: "Save version" }));
    expect(await within(form).findByText("No voice has that id")).toBeInTheDocument();
    expect(voice).toHaveAttribute("aria-invalid", "true");
  });

  it("offers to save over a version saved meanwhile", async () => {
    const setup = seriesSetup();
    const requests = recordRequests();
    const { user } = renderApp(formatPath(setup), setup.db);
    const form = await editor();

    // Someone else saves version 3 while the form is open.
    const stored = setup.db.formats.find((format) => format.id === setup.formats.ownership.id);
    if (!stored) throw new Error("missing format");
    const theirs = {
      ...stored.currentVersion,
      id: mockId(),
      versionNo: 3,
      createdAt: new Date().toISOString(),
    };
    setup.db.formatVersions.push(theirs);
    stored.currentVersion = theirs;

    const tone = within(form).getByLabelText("Tone");
    await user.clear(tone);
    await user.type(tone, "Dry and funny.");
    await user.click(within(form).getByRole("button", { name: "Save version" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This format changed since you opened it");

    await user.click(within(alert).getByRole("button", { name: "Save mine over it" }));
    expect(await screen.findByText("Saved as version 4")).toBeInTheDocument();
    const sent = updates(requests);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.baseVersionId).toBe(theirs.id);
    expect(sent[1]?.rules?.tone).toBe("Dry and funny.");
  });
});
