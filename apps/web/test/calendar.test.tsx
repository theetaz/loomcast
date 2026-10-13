import { routes } from "@loomcast/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPost, updatePost } from "@/mocks/calendar";
import { CALENDAR_NOW, CALENDAR_ZONE, calendarSetup } from "./support/calendar";
import { recordRequests } from "./support/kb";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";

const previousZone = process.env.TZ;

beforeAll(() => {
  // The browser's time zone: the grid follows it unless the series zone is chosen.
  process.env.TZ = CALENDAR_ZONE;
});
afterAll(() => {
  process.env.TZ = previousZone;
});
beforeEach(() => {
  // Only the clock is fixed; timers stay real for the router, MSW and user-event.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CALENDAR_NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

type Setup = ReturnType<typeof calendarSetup>;

function renderCalendar(
  setup: Setup,
  path = "/calendar",
  overrides: Parameters<typeof renderApp>[2] = [],
) {
  const stream = fakeStream(setup.db);
  const view = renderApp(path, setup.db, overrides, { createEventSource: stream.factory });
  return { ...view, stream };
}

function chip(title: RegExp | string) {
  return screen.getByRole("button", {
    name: typeof title === "string" ? new RegExp(`^${title}`) : title,
  });
}

function cellOf(element: HTMLElement): string | undefined {
  return (element.closest("[data-cell]") as HTMLElement | null)?.dataset.cell;
}

function liveRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>('[id^="DndLiveRegion"]');
  if (!region) throw new Error("dnd-kit's live region is missing");
  return region;
}

const MOVES = "Moves explained with a cup";

describe("calendar week view", () => {
  it("shows the week's posts with their channel, time and state, and open slots", async () => {
    const setup = calendarSetup();
    renderCalendar(setup);

    expect(await screen.findByRole("heading", { name: "12 – 18 Oct 2026" })).toBeInTheDocument();
    const moves = await screen.findByRole("button", { name: new RegExp(`^${MOVES}`) });
    expect(moves).toHaveAccessibleName(
      `${MOVES}. @rustin60 (Instagram), Friday 16 October, 09:00. Queued.`,
    );
    expect(cellOf(moves)).toBe("cell:2026-10-16:6");
    expect(within(moves).getByText("Queued")).toHaveAttribute("data-tone", "blue");

    const published = chip("What to log when it fails");
    expect(within(published).getByText("Published")).toHaveAttribute("data-tone", "green");
    // Published posts open their video but can't be dragged.
    expect(published).not.toHaveAttribute("aria-roledescription");
    expect(moves).toHaveAttribute("aria-roledescription", "draggable");

    // Friday's Threads slot is open; Wednesday's 09:00 slot is now, too soon to fill.
    expect(
      await screen.findByRole("button", {
        name: "Open slot, Friday 16 October at 09:00: Ownership basics on Rust threads (Threads). Schedule an approved video.",
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: /^Open slot, Wednesday 14 October at 09:00: Ownership basics on Rust threads/,
      }),
    ).toBeDisabled();
    expect(screen.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
  });

  it("sends channel and series filters comma-separated and keeps them in the address", async () => {
    const setup = calendarSetup();
    const requests = recordRequests();
    const { user, router } = renderCalendar(setup);
    await screen.findByRole("button", { name: new RegExp(`^${MOVES}`) });

    await user.click(screen.getByRole("button", { name: "Channels: All channels" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Rust threads/ }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /@rustin60/ }));
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        channels: `${setup.channels.threads.id},${setup.channels.instagram.id}`,
      }),
    );
    const last = requests.filter((request) => request.path === "/api/calendar").at(-1);
    expect(last?.query.get("channelIds")?.split(",").sort()).toEqual(
      [setup.channels.instagram.id, setup.channels.threads.id].sort(),
    );
    expect(last?.query.get("from")).toBe("2026-10-11T23:00:00.000Z");
    expect(last?.query.get("to")).toBe("2026-10-18T23:00:00.000Z");
    expect(screen.getByRole("button", { name: "Channels: 2 channels" })).toBeInTheDocument();
  });

  it("changes the week with the arrow keys and comes back with t", async () => {
    const setup = calendarSetup();
    const { user } = renderCalendar(setup);
    await screen.findByRole("heading", { name: "12 – 18 Oct 2026" });

    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("heading", { name: "19 – 25 Oct 2026" })).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(await screen.findByRole("heading", { name: "5 – 11 Oct 2026" })).toBeInTheDocument();
    await user.keyboard("t");
    expect(await screen.findByRole("heading", { name: "12 – 18 Oct 2026" })).toBeInTheDocument();
  });

  it("follows the series time zone when asked", async () => {
    const setup = calendarSetup();
    process.env.TZ = "Asia/Colombo";
    try {
      const { user } = renderCalendar(setup);
      const moves = await screen.findByRole("button", { name: new RegExp(`^${MOVES}`) });
      expect(cellOf(moves)).toBe("cell:2026-10-16:15");

      await user.click(screen.getByRole("button", { name: "Time zone: Asia/Colombo" }));
      await user.click(await screen.findByRole("menuitemradio", { name: /Series time zone/ }));
      await waitFor(() =>
        expect(cellOf(screen.getByRole("button", { name: new RegExp(`^${MOVES}`) }))).toBe(
          "cell:2026-10-16:6",
        ),
      );
      expect(screen.getByRole("button", { name: "Time zone: Europe/London" })).toBeInTheDocument();
    } finally {
      process.env.TZ = CALENDAR_ZONE;
    }
  });
});

describe("rescheduling", () => {
  it("moves a post with the keyboard alone, without animating, and saves it", async () => {
    const setup = calendarSetup();
    const loadedAt = setup.posts.moves.updatedAt;
    const requests = recordRequests();
    const { user } = renderCalendar(setup);
    const moves = await screen.findByRole("button", { name: new RegExp(`^${MOVES}`) });

    moves.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(liveRegion()).toHaveTextContent(`Picked up ${MOVES}`));
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowLeft}");

    // The marker jumps to Thursday 10:00; no lifted copy follows the keys.
    const over = document.querySelector<HTMLElement>("[data-over]");
    expect(over?.dataset.cell).toBe("cell:2026-10-15:8");
    expect(within(over as HTMLElement).getByText("→ 10:00")).toBeInTheDocument();
    expect(document.querySelector("[data-drag-overlay]")).toBeNull();
    await waitFor(() =>
      expect(liveRegion()).toHaveTextContent(`${MOVES} is over Thursday 15 October, 10:00.`),
    );

    await user.keyboard(" ");
    await waitFor(() =>
      expect(cellOf(screen.getByRole("button", { name: new RegExp(`^${MOVES}`) }))).toBe(
        "cell:2026-10-15:8",
      ),
    );
    expect(liveRegion()).toHaveTextContent(`${MOVES} moved to Thursday 15 October, 10:00.`);
    await waitFor(() =>
      expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({
        scheduledAt: "2026-10-15T09:00:00.000Z",
        expectedUpdatedAt: loadedAt,
      }),
    );
    await waitFor(() =>
      expect(setup.db.posts.find((post) => post.id === setup.posts.moves.id)?.scheduledAt).toBe(
        "2026-10-15T09:00:00.000Z",
      ),
    );
    // Focus follows the post to its new cell, and stays there once the save settles. The chip is
    // looked up again on every check: the move, the save and the live event re-render it.
    const movedChip = () =>
      document.querySelector<HTMLElement>(`[data-post-chip="${setup.posts.moves.id}"]`);
    await waitFor(
      () => {
        expect(cellOf(movedChip() as HTMLElement)).toBe("cell:2026-10-15:8");
        expect(movedChip()).not.toHaveAttribute("aria-busy");
        expect(document.activeElement).toBe(movedChip());
      },
      { timeout: 10_000 },
    );
  });

  it("cancels a keyboard move with Escape", async () => {
    const setup = calendarSetup();
    const requests = recordRequests();
    const { user } = renderCalendar(setup);
    const moves = await screen.findByRole("button", { name: new RegExp(`^${MOVES}`) });
    moves.focus();
    await user.keyboard(" ");
    await user.keyboard("{ArrowRight}{Escape}");
    await waitFor(() => expect(liveRegion()).toHaveTextContent("Moving cancelled."));
    expect(cellOf(chip(MOVES))).toBe("cell:2026-10-16:6");
    expect(document.querySelector("[data-over]")).toBeNull();
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("puts the post back and says why when saving fails", async () => {
    const setup = calendarSetup();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = renderCalendar(setup, "/calendar", [
      http.patch(`*${routes["scheduledPosts.reschedule"].path}`, async () => {
        await held;
        return HttpResponse.json({ error: { code: "internal", message: "Boom" } }, { status: 500 });
      }),
    ]);
    const moves = await screen.findByRole("button", { name: new RegExp(`^${MOVES}`) });
    moves.focus();
    await user.keyboard(" ");
    await user.keyboard("{ArrowDown}");
    await user.keyboard(" ");

    // Optimistic: the post shows at 09:30 while the move is saving.
    await waitFor(() => expect(cellOf(chip(MOVES))).toBe("cell:2026-10-16:7"));
    release();
    expect(await screen.findByText("Couldn't move the post")).toBeInTheDocument();
    await waitFor(() => expect(cellOf(chip(MOVES))).toBe("cell:2026-10-16:6"));
  });

  it("refetches and explains when the post changed elsewhere", async () => {
    const setup = calendarSetup();
    const { user } = renderCalendar(setup, "/calendar", [
      http.patch(`*${routes["scheduledPosts.reschedule"].path}`, () => {
        // Someone else moved it to Saturday first.
        const post = setup.db.posts.find((entry) => entry.id === setup.posts.moves.id);
        if (post) {
          post.scheduledAt = "2026-10-17T10:00:00.000Z";
          post.updatedAt = "2026-10-14T07:59:00.000Z";
        }
        return HttpResponse.json(
          { error: { code: "conflict", message: "The post changed since you loaded it." } },
          { status: 409 },
        );
      }),
    ]);
    const moves = await screen.findByRole("button", { name: new RegExp(`^${MOVES}`) });
    moves.focus();
    await user.keyboard(" ");
    await user.keyboard("{ArrowLeft}");
    await user.keyboard(" ");

    expect(
      await screen.findByText(
        "This post changed somewhere else. The calendar now shows the latest times.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(cellOf(chip(MOVES))).toBe("cell:2026-10-17:10"));
  });

  it("does not drop into the past", async () => {
    const setup = calendarSetup();
    const requests = recordRequests();
    const { user } = renderCalendar(setup);
    const moves = await screen.findByRole("button", { name: new RegExp(`^${MOVES}`) });
    moves.focus();
    await user.keyboard(" ");
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(
      within(document.querySelector("[data-over]") as HTMLElement).getByText("Too soon"),
    ).toBeInTheDocument();
    await user.keyboard(" ");
    expect(await screen.findByText("Pick a later time")).toBeInTheDocument();
    expect(cellOf(chip(MOVES))).toBe("cell:2026-10-16:6");
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("moves a post when another tab or the scheduler changes it", async () => {
    const setup = calendarSetup();
    renderCalendar(setup);
    const moves = await screen.findByRole("button", { name: new RegExp(`^${MOVES}`) });
    expect(cellOf(moves)).toBe("cell:2026-10-16:6");

    updatePost(setup.db, setup.posts.moves.id, (post) => {
      post.scheduledAt = "2026-10-18T17:00:00.000Z";
      post.status = "publishing";
    });
    await waitFor(() => expect(cellOf(chip(MOVES))).toBe("cell:2026-10-18:24"));
    expect(within(chip(MOVES)).getByText("Publishing")).toBeInTheDocument();
    expect(chip(MOVES)).not.toHaveAttribute("aria-roledescription");
  });
});

describe("open slots", () => {
  it("schedules an approved video into an open slot", async () => {
    const setup = calendarSetup();
    const requests = recordRequests();
    const { user } = renderCalendar(setup);
    const slot = await screen.findByRole("button", {
      name: "Open slot, Thursday 15 October at 18:00: Error handling on @rustin60 (Instagram). Schedule an approved video.",
    });
    await user.click(slot);

    const dialog = await screen.findByRole("dialog", { name: "Fill this slot" });
    expect(dialog).toHaveTextContent(
      "Error handling on @rustin60 (Instagram), Thursday 15 October, 18:00.",
    );
    await user.click(await within(dialog).findByRole("radio", { name: /Result is just an enum/ }));
    await user.click(within(dialog).getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      requests.find(
        (request) => request.method === "POST" && request.path === "/api/scheduled-posts",
      )?.body,
    ).toEqual({
      itemId: setup.items.result.id,
      channelId: setup.channels.instagram.id,
      scheduledAt: "2026-10-15T17:00:00.000Z",
    });
    const scheduled = await screen.findByRole("button", { name: /^Result is just an enum/ });
    expect(cellOf(scheduled)).toBe("cell:2026-10-15:24");
    expect(
      screen.queryByRole("button", { name: /^Open slot, Thursday 15 October at 18:00/ }),
    ).toBeNull();
    expect(await screen.findByText("Scheduled “Result is just an enum”")).toBeInTheDocument();
  });
});

describe("calendar month view", () => {
  it("shows three posts a day, then +n more, which opens that week", async () => {
    const setup = calendarSetup();
    const { channels, items, db } = setup;
    // Saturday has no cadence slots: four posts and nothing else.
    for (const [hour, channel] of [
      [8, channels.threads],
      [9, channels.threads],
      [10, channels.instagram],
      [11, channels.instagram],
    ] as const) {
      db.posts.push(
        mockPost({
          item: hour === 8 ? items.moves : items.result,
          channel,
          scheduledAt: `2026-10-24T${String(hour).padStart(2, "0")}:00:00.000Z`,
          status: "planned",
        }),
      );
    }
    const { user } = renderCalendar(setup, "/calendar?view=month&date=2026-10-20");

    expect(await screen.findByRole("heading", { name: "October 2026" })).toBeInTheDocument();
    const day = await waitFor(() => {
      const cell = document.querySelector<HTMLElement>('[data-cell="day:2026-10-24"]');
      expect(cell?.querySelectorAll("[data-post-chip]")).toHaveLength(3);
      return cell as HTMLElement;
    });
    const more = within(day).getByRole("button", {
      name: "1 more on Saturday 24 October. Show the week.",
    });
    expect(more).toHaveTextContent("+1 more");

    await user.click(more);
    expect(await screen.findByRole("heading", { name: "19 – 25 Oct 2026" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Week" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-cell^="cell:2026-10-24"] [data-post-chip]'),
      ).toHaveLength(4),
    );
  });

  it("moves a post by a week with the keyboard and keeps its time", async () => {
    const setup = calendarSetup();
    const requests = recordRequests();
    const { user } = renderCalendar(setup, "/calendar?view=month");
    const moves = await screen.findByRole("button", { name: new RegExp(`^${MOVES}`) });
    expect(cellOf(moves)).toBe("day:2026-10-16");
    moves.focus();
    await user.keyboard(" ");
    await user.keyboard("{ArrowDown}");
    await user.keyboard(" ");
    await waitFor(() => expect(cellOf(chip(MOVES))).toBe("day:2026-10-23"));
    await waitFor(() =>
      expect(requests.find((request) => request.method === "PATCH")?.body).toMatchObject({
        scheduledAt: "2026-10-23T08:00:00.000Z",
      }),
    );
  });
});
