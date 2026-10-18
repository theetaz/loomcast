import { routes, type ScheduledPost } from "@loomcast/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOptions,
  draftIssues,
  EMPTY_OPTIONS,
  moveEntry,
  optionFieldsFor,
  parseCollaborators,
} from "@/features/composer/draft";
import { outcomeMessage } from "@/features/composer/ScheduleForm";
import { tabsFor } from "@/features/content-item/ItemPage";
import {
  channelPublishes,
  platformsFor,
  publishableFormats,
} from "@/features/post-formats/channels";
import { FormatBadge, FormatIcon } from "@/features/post-formats/FormatBadge";
import { CarouselPreview, PostPreview } from "@/features/post-formats/MediaPreview";
import { checkPostMediaFile, postMediaType } from "@/features/post-formats/media-upload";
import { ApiError } from "@/lib/api";
import { recordRequests } from "./support/kb";
import { photo, postSetup, StorageXhr } from "./support/post-formats";
import { renderApp } from "./support/render";

const DAY_MS = 24 * 60 * 60_000;

/** `YYYY-MM-DDTHH:mm` a day from now, for a `datetime-local` input. */
function tomorrowInput(): string {
  const date = new Date(Date.now() + DAY_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:00`;
}

function withQueries(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

let objectUrls = 0;
beforeEach(() => {
  objectUrls = 0;
  URL.createObjectURL = vi.fn(() => {
    objectUrls += 1;
    return `blob:preview-${objectUrls}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  StorageXhr.reset();
  vi.unstubAllGlobals();
});

describe("post format rules", () => {
  it("offers only the formats a channel publishes, and the platforms of each", () => {
    expect(publishableFormats([{ platform: "threads" }])).toEqual(["reel"]);
    expect(publishableFormats([{ platform: "instagram" }, { platform: "threads" }])).toEqual([
      "reel",
      "image",
      "carousel",
      "story",
    ]);
    expect(publishableFormats([{ platform: "facebook" }])).toContain("text");
    expect(platformsFor("carousel")).toEqual(["facebook", "instagram"]);
    expect(platformsFor("text")).toEqual(["facebook"]);
  });

  it("leaves Facebook out of carousels with a video", () => {
    const facebook = { platform: "facebook" as const };
    expect(channelPublishes(facebook, "carousel", [{ type: "image" }, { type: "image" }])).toBe(
      true,
    );
    expect(channelPublishes(facebook, "carousel", [{ type: "image" }, { type: "video" }])).toBe(
      false,
    );
    expect(
      channelPublishes({ platform: "instagram" }, "carousel", [
        { type: "video" },
        { type: "image" },
      ]),
    ).toBe(true);
    expect(channelPublishes({ platform: "threads" }, "image")).toBe(false);
  });

  it("explains what a draft still needs", () => {
    expect(draftIssues("carousel", [{ type: "image", altText: "" }], "")).toEqual([
      "A carousel needs at least 2 items.",
    ]);
    expect(draftIssues("image", [{ type: "video", altText: "" }], "")).toEqual([
      "A photo post cannot carry a video.",
    ]);
    expect(draftIssues("text", [], "  ")).toEqual(["A text post needs its words."]);
    expect(draftIssues("text", [], "Hello")).toEqual([]);
    expect(
      draftIssues(
        "carousel",
        [
          { type: "image", altText: "" },
          { type: "video", altText: "" },
        ],
        "",
      ),
    ).toEqual([]);
  });

  it("moves an entry to a new place", () => {
    expect(moveEntry(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveEntry(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
    expect(moveEntry(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });

  it("tells photos from videos by type or extension", () => {
    expect(postMediaType(photo("a.png"))).toBe("image");
    expect(postMediaType(new File(["x"], "clip.mov", { type: "" }))).toBe("video");
    expect(postMediaType(new File(["x"], "notes.txt", { type: "text/plain" }))).toBeNull();
    expect(checkPostMediaFile(new File([], "empty.jpg", { type: "image/jpeg" }))).toBe(
      "That file is empty.",
    );
  });

  it("builds only the options the chosen platforms offer for the format", () => {
    expect(optionFieldsFor("instagram", "reel")).toEqual([
      "collaborators",
      "locationId",
      "shareToFeed",
    ]);
    expect(optionFieldsFor("instagram", "story")).toEqual([]);
    expect(optionFieldsFor("facebook", "text")).toEqual(["link"]);
    expect(parseCollaborators("@ferris, rustlang  crab.dev")).toEqual([
      "ferris",
      "rustlang",
      "crab.dev",
    ]);

    const fields = {
      ...EMPTY_OPTIONS,
      collaborators: "ferris, rustlang",
      locationId: "110843418940484",
      shareToFeed: false,
      link: "https://loomcast.example/post",
      title: "Ignored",
    };
    expect(buildOptions(fields, "reel", ["instagram", "threads"])).toEqual({
      options: {
        instagram: {
          collaborators: ["ferris", "rustlang"],
          locationId: "110843418940484",
          shareToFeed: false,
        },
      },
      errors: {},
    });
    expect(buildOptions(fields, "text", ["facebook"]).options).toEqual({
      facebook: { link: "https://loomcast.example/post" },
    });
    expect(buildOptions(EMPTY_OPTIONS, "image", ["instagram"]).options).toBeUndefined();

    const bad = buildOptions(
      { ...EMPTY_OPTIONS, collaborators: "a, b, c, d", locationId: "here", link: "ftp://x" },
      "image",
      ["instagram", "facebook"],
    );
    expect(bad.errors.collaborators).toBe("Invite at most 3 collaborators.");
    expect(bad.errors.locationId).toBe("A location is a Facebook Page id: digits only.");
    expect(bad.errors.link).toBeUndefined();
    expect(
      buildOptions({ ...EMPTY_OPTIONS, link: "ftp://x" }, "text", ["facebook"]).errors.link,
    ).toBe("Use a full web address that starts with https://.");
  });

  it("names a refused channel's reason", () => {
    expect(
      outcomeMessage(
        new ApiError(422, "format_not_supported", "Threads does not publish photos.", {}),
      ),
    ).toBe("Threads does not publish photos.");
    expect(outcomeMessage(new ApiError(409, "conflict", ""))).toBe(
      "It already has an open post on this channel.",
    );
  });

  it("gives a composed post one tab and a studio video its production tabs", () => {
    expect(tabsFor({ format: "image", media: [{ type: "image" }] })).toEqual(["post"]);
    expect(tabsFor({ format: "reel", hasScript: true })).toEqual([
      "script",
      "storyboard",
      "voice",
      "video",
    ]);
  });
});

describe("format badge", () => {
  it("names the format beside its icon", () => {
    render(<FormatBadge format="carousel" />);
    expect(screen.getByText("Carousel")).toBeInTheDocument();
  });

  it("is an image named after the format, or decorative", () => {
    const { container } = render(
      <>
        <FormatIcon format="story" label />
        <FormatIcon format="text" />
      </>,
    );
    expect(screen.getByRole("img", { name: "Story" })).toHaveAttribute("title", "Story");
    expect(container.querySelector('[data-format="text"]')).toHaveAttribute("aria-hidden", "true");
  });
});

describe("media previews", () => {
  const media = [
    { key: "a", type: "image" as const, url: "blob:a", altText: "Ferris on a laptop" },
    { key: "b", type: "image" as const, url: "blob:b", altText: "" },
    { key: "c", type: "video" as const, url: "blob:c" },
  ];

  it("steps a carousel with buttons, arrow keys and a counter", async () => {
    const user = userEvent.setup();
    const { container } = render(withQueries(<CarouselPreview media={media} />));
    const carousel = screen.getByRole("region", { name: "Carousel preview" });
    expect(carousel).toHaveAccessibleDescription("Item 1 of 3");
    expect(screen.getByRole("button", { name: "Previous item" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Next item" }));
    expect(carousel).toHaveAccessibleDescription("Item 2 of 3");
    expect(screen.getByRole("group", { name: "2 of 3" })).not.toHaveAttribute("aria-hidden");
    // The other slides are hidden and inert, out of the tab order.
    const slides = container.querySelectorAll('[aria-roledescription="slide"]');
    expect(slides[0]).toHaveAttribute("aria-hidden", "true");
    expect(slides[0]).toHaveAttribute("inert");

    screen.getByRole("button", { name: "Next item" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(carousel).toHaveAccessibleDescription("Item 3 of 3");
    expect(screen.getByRole("button", { name: "Next item" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(carousel).toHaveAccessibleDescription("Item 1 of 3");
  });

  it("shows a photo's alt text on hover and focus, and gives it to the image", () => {
    render(withQueries(<PostPreview format="image" media={[media[0] as (typeof media)[0]]} />));
    const image = screen.getByRole("img", { name: "Ferris on a laptop" });
    const figure = image.closest("figure");
    expect(figure).toHaveAttribute("tabindex", "0");
    const caption = figure?.querySelector("[data-alt-text]");
    expect(caption).toHaveTextContent("ALTFerris on a laptop");
    expect(caption?.className).toContain("group-hover/media:opacity-100");
    expect(caption?.className).toContain("group-focus-visible/media:opacity-100");
  });

  it("frames a story at 9:16 with its label, and a text post with its link", () => {
    const { container, rerender } = render(
      withQueries(<PostPreview format="story" media={[media[2] as (typeof media)[2]]} />),
    );
    expect(screen.getByText("Story")).toBeInTheDocument();
    expect(container.querySelector(".aspect-\\[9\\/16\\]")).not.toBeNull();
    expect(container.querySelector("video")).toHaveAttribute("aria-label", "Video");

    rerender(
      withQueries(
        <PostPreview
          format="text"
          media={[]}
          caption="Why Rust has no null"
          link="https://loomcast.example/null"
        />,
      ),
    );
    expect(screen.getByText("Why Rust has no null")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /loomcast\.example/ });
    expect(link).toHaveAttribute("href", "https://loomcast.example/null");
  });
});

describe("composed posts on the item page", () => {
  it("shows the carousel instead of the production tabs, with no production controls", async () => {
    const { db, compose } = postSetup();
    const { item } = compose("Five photos", "carousel", "render", ["image", "image", "image"]);
    renderApp(`/content/${item.id}`, db);

    const tabs = await screen.findByRole("tablist", { name: "The post" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Post"]);
    expect(
      await screen.findByRole("region", { name: "Carousel preview" }),
    ).toHaveAccessibleDescription("Item 1 of 3");
    expect(await screen.findByRole("img", { name: "Alt text of photo 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Produce" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Script" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Carousel").length).toBeGreaterThan(0);
  });

  it("sends a composed post that fits its format to review", async () => {
    const { db, compose } = postSetup();
    const { item, version } = compose("One photo", "image", "render", ["image"]);
    const requests = recordRequests();
    const { user } = renderApp(`/content/${item.id}`, db);

    await user.click(await screen.findByRole("button", { name: "Submit for review" }));
    await waitFor(() =>
      expect(requests.find((request) => request.path.endsWith("/submit"))?.body).toEqual({
        versionId: version.id,
      }),
    );
    expect((await screen.findAllByRole("button", { name: "Approve" })).length).toBeGreaterThan(0);
  });

  it("schedules an approved post with its options, and shows a refused channel inline", async () => {
    const { db, compose, channels } = postSetup({ facebook: true });
    const { item } = compose("Ten-second tip", "video", "approved", ["video"]);
    const requests = recordRequests();
    const refused = http.post(`*${routes["scheduledPosts.create"].path}`, async ({ request }) => {
      const body = (await request.clone().json()) as { channelId: string };
      if (body.channelId !== channels.facebook.id) return undefined;
      return HttpResponse.json(
        {
          error: {
            code: "format_not_supported",
            message: "Facebook does not publish videos right now.",
          },
        },
        { status: 422 },
      );
    });
    const { user } = renderApp(`/content/${item.id}`, db, [refused]);

    await user.click(await screen.findByRole("button", { name: "Schedule" }));
    const dialog = await screen.findByRole("dialog", { name: /Schedule/ });
    // Only Facebook publishes regular videos.
    expect(within(dialog).queryByRole("checkbox", { name: /@rustin60/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: /Rust in 60 seconds/ }));
    const title = within(dialog).getByLabelText("Facebook video title");
    expect(title).toHaveValue("Ten-second tip");
    await user.clear(title);
    await user.type(title, "A tip in ten seconds");
    await user.click(within(dialog).getByRole("button", { name: "Schedule" }));

    expect(
      await within(dialog).findByText("Facebook does not publish videos right now."),
    ).toBeVisible();
    const create = requests.find((request) => request.path === "/api/scheduled-posts");
    expect(create?.body).toMatchObject({
      itemId: item.id,
      channelId: channels.facebook.id,
      options: { facebook: { title: "A tip in ten seconds" } },
    });
  });
});

describe("composer", () => {
  it("offers the formats the channels publish and says what each still needs", async () => {
    const { db } = postSetup();
    const { user } = renderApp("/library", db);
    await user.click(await screen.findByRole("button", { name: "New post" }));
    const dialog = await screen.findByRole("dialog", { name: "New post" });

    const formats = await within(dialog).findAllByRole("radio");
    // Instagram and Threads are active; the Facebook Page is disabled, so no video or text post.
    expect(formats.map((radio) => radio.getAttribute("value"))).toEqual([
      "reel",
      "image",
      "carousel",
      "story",
    ]);
    expect(within(dialog).getByRole("radio", { name: /Photo/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Reel/ })).toHaveAccessibleDescription(
      "Facebook, Instagram, Threads, X",
    );
    expect(within(dialog).getByText("A photo post needs at least 1 item.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save draft" })).toBeEnabled();

    await user.click(within(dialog).getByRole("radio", { name: /Carousel/ }));
    expect(within(dialog).getByText("A carousel needs at least 2 items.")).toBeInTheDocument();
    await user.upload(within(dialog).getByLabelText("Add photos or videos"), photo("one.png", 1));
    expect(within(dialog).getByText("A carousel needs at least 2 items.")).toBeInTheDocument();
    await user.upload(within(dialog).getByLabelText("Add photos or videos"), photo("two.png", 2));
    expect(within(dialog).queryByText(/needs at least/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save post" })).toBeEnabled();
    expect(
      within(dialog).getByRole("region", { name: "Carousel preview" }),
    ).toHaveAccessibleDescription("Item 1 of 2");
  });

  it("reorders, describes and saves the media, then submits, approves and schedules", async () => {
    const { db, project, channels } = postSetup();
    StorageXhr.reset(db);
    vi.stubGlobal("XMLHttpRequest", StorageXhr);
    const requests = recordRequests();
    const { user } = renderApp("/library", db);
    await user.click(await screen.findByRole("button", { name: "New post" }));
    const dialog = await screen.findByRole("dialog", { name: "New post" });

    await user.click(await within(dialog).findByRole("radio", { name: /Carousel/ }));
    await user.type(within(dialog).getByLabelText("Title"), "Brand colours");
    await user.type(within(dialog).getByLabelText(/Caption/), "Thread and Ember.");
    await user.upload(within(dialog).getByLabelText("Add photos or videos"), [
      photo("thread.png", 1),
      photo("ember.png", 2),
    ]);
    const list = within(dialog).getByRole("list", { name: "Photos and videos" });
    await user.click(within(list).getByRole("button", { name: "Move photo 2 up" }));
    const names = within(list)
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(names[0]).toContain("ember.png");
    expect(names[1]).toContain("thread.png");
    await user.type(within(list).getByLabelText("Alt text for photo 1"), "An ember swatch");

    await user.click(within(dialog).getByRole("button", { name: "Save post" }));
    expect(await screen.findByRole("heading", { name: "Post saved" })).toHaveFocus();
    expect(StorageXhr.sent).toHaveLength(2);

    const create = requests.find(
      (request) => request.path === `/api/projects/${project.id}/content`,
    );
    expect(create?.body).toEqual({ title: "Brand colours", format: "carousel" });
    const edit = requests.find((request) => /\/api\/content\/[^/]+\/versions$/.test(request.path));
    const media = (
      (edit as { body: unknown }).body as {
        media: { assetId: string; type: string; altText?: string }[];
      }
    ).media;
    expect(media.map((entry) => [entry.type, entry.altText])).toEqual([
      ["image", "An ember swatch"],
      ["image", undefined],
    ]);
    expect(edit?.body).toMatchObject({ caption: "Thread and Ember." });
    const assets = db.assets.filter((asset) => asset.kind === "media");
    expect(assets.map((asset) => asset.filename)).toEqual(["ember.png", "thread.png"]);
    expect(media.map((entry) => entry.assetId)).toEqual(assets.map((asset) => asset.id));

    await user.click(screen.getByRole("button", { name: "Schedule now" }));
    const form = await screen.findByRole("form", { name: "Schedule" });
    // Threads doesn't publish carousels.
    expect(within(form).queryByRole("checkbox", { name: /Rust threads/ })).not.toBeInTheDocument();
    expect(within(form).getByText(/Threads doesn't publish carousels/)).toBeInTheDocument();
    await user.click(within(form).getByRole("checkbox", { name: /@rustin60/ }));
    const when = within(form).getByLabelText("When");
    await user.clear(when);
    await user.type(when, tomorrowInput());
    await user.type(within(form).getByLabelText("Instagram collaborators"), "ferris, rustlang");
    await user.click(within(form).getByRole("button", { name: "Approve and schedule" }));

    await waitFor(() =>
      expect(db.posts.some((post) => post.channelId === channels.instagram.id)).toBe(true),
    );
    const item = db.contentItems.find((entry) => entry.title === "Brand colours");
    const paths = requests.map((request) => `${request.method} ${request.path}`);
    const submitAt = paths.indexOf(`POST /api/content/${item?.id}/submit`);
    const approveAt = paths.indexOf(`POST /api/content/${item?.id}/reviews`);
    const scheduleAt = paths.indexOf("POST /api/scheduled-posts");
    expect(submitAt).toBeGreaterThan(-1);
    expect(approveAt).toBeGreaterThan(submitAt);
    expect(scheduleAt).toBeGreaterThan(approveAt);
    const schedule = requests[scheduleAt];
    expect(schedule?.body).toEqual({
      itemId: item?.id,
      channelId: channels.instagram.id,
      scheduledAt: expect.any(String),
      options: { instagram: { collaborators: ["ferris", "rustlang"] } },
    });
    expect(
      Date.parse(((schedule as { body: unknown }).body as ScheduledPost).scheduledAt),
    ).toBeGreaterThan(Date.now());
    expect(item?.state).toBe("scheduled");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("refuses files the format can't carry", async () => {
    const { db } = postSetup();
    const { user } = renderApp("/library", db);
    await user.click(await screen.findByRole("button", { name: "New post" }));
    const dialog = await screen.findByRole("dialog", { name: "New post" });
    await within(dialog).findAllByRole("radio");
    const input = within(dialog).getByLabelText("Choose a photo or video");
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "clip.mp4", { type: "video/mp4" })],
      configurable: true,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A photo takes photos only.",
    );
  });
});
