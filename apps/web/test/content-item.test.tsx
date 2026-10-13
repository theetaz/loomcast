import { routes } from "@loomcast/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mockVersion } from "@/mocks/content";
import { mockAsset } from "@/mocks/content-item";
import { itemSetup, renderItem, startJob } from "./support/content-item";
import { recordRequests } from "./support/kb";

const heading = (title: string) => screen.findByRole("heading", { level: 1, name: title });
/** The page header, where the state pill and the actions are. */
function header(): HTMLElement {
  const title = screen.getByRole("heading", { level: 1 });
  return title.closest("header") as HTMLElement;
}

async function headerPill(label: string) {
  await waitFor(() =>
    expect(
      within(header()).getByText(label, { selector: "[data-slot=status-pill]" }),
    ).toBeVisible(),
  );
}

const actions = () => screen.queryAllByRole("button").map((button) => button.textContent?.trim());

function bodiesOf(requests: ReturnType<typeof recordRequests>, method: string, suffix: string) {
  return requests
    .filter((request) => request.method === method && request.path.endsWith(suffix))
    .map((request) => request.body);
}

describe("item page actions", () => {
  it("offers review decisions for an item in review, and no production", async () => {
    const { db, items } = itemSetup();
    renderItem(db, items.review.id);
    await heading(items.review.title);
    await headerPill("In review");
    expect(await screen.findAllByRole("button", { name: "Approve" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Request changes" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Reject" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Produce" })).not.toBeInTheDocument();
  });

  it("offers production, not review, for an item being scripted", async () => {
    const { db, items } = itemSetup();
    const requests = recordRequests();
    const { user } = renderItem(db, items.script.id);
    await heading(items.script.title);
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Review" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Produce" }));
    await waitFor(() =>
      expect(bodiesOf(requests, "POST", "/actions")).toEqual([
        { action: "produce", through: "review" },
      ]),
    );
    // The job shows in the banner and production can't start twice.
    expect(await screen.findByRole("region", { name: "Production job" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Produce" })).toBeDisabled();
  });

  it("only restores an archived item and only archives a published one", async () => {
    const { db, items } = itemSetup();
    const first = renderItem(db, items.archived.id);
    await heading(items.archived.title);
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    first.unmount();

    renderItem(db, items.published.id);
    await heading(items.published.title);
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    for (const name of ["Produce", "Approve", "Reject", "Restore", "Edit script"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("keeps Approve off for an item in review without a render", async () => {
    const { db, items } = itemSetup();
    const current = db.contentVersions.find((v) => v.id === items.review.currentVersionId);
    if (current) current.renderAssetId = null;
    renderItem(db, items.review.id, "?tab=script");
    await heading(items.review.title);
    const panel = await screen.findByRole("region", { name: "Review" });
    expect(within(panel).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(panel).getByText("Approving needs a rendered video.")).toBeInTheDocument();
    // The header lists only what is allowed.
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
  });

  it("approves the current version", async () => {
    const { db, items } = itemSetup();
    const requests = recordRequests();
    const { user } = renderItem(db, items.review.id, "?tab=script");
    const panel = await screen.findByRole("region", { name: "Review" });
    await user.click(within(panel).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(bodiesOf(requests, "POST", "/reviews")).toEqual([
        { versionId: items.review.currentVersionId, decision: "approve" },
      ]),
    );
    await headerPill("Approved");
  });

  it("needs a comment to request changes and sends it with ⌘Enter", async () => {
    const { db, items } = itemSetup();
    const requests = recordRequests();
    const { user } = renderItem(db, items.review.id, "?tab=script");
    const panel = await screen.findByRole("region", { name: "Review" });
    const comment = within(panel).getByRole("textbox", { name: "What should change?" });
    expect(
      within(panel).getByRole("checkbox", { name: "Ask the producer to revise" }),
    ).toBeChecked();

    await user.click(within(panel).getByRole("button", { name: "Request changes" }));
    expect(await within(panel).findByText("Say what should change.")).toBeInTheDocument();
    expect(bodiesOf(requests, "POST", "/reviews")).toEqual([]);

    // The header button takes the reviewer to the comment.
    await user.click(screen.getAllByRole("button", { name: "Request changes" })[0] as HTMLElement);
    expect(comment).toHaveFocus();
    await user.type(comment, "Open on the error.");
    await user.click(within(panel).getByRole("checkbox", { name: "Ask the producer to revise" }));
    await user.click(comment);
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() =>
      expect(bodiesOf(requests, "POST", "/reviews")).toEqual([
        {
          versionId: items.review.currentVersionId,
          decision: "request_changes",
          comment: "Open on the error.",
          enqueueRevision: false,
        },
      ]),
    );
    await headerPill("Script");
  });

  it("asks before rejecting, and has no single-key shortcuts", async () => {
    const { db, items } = itemSetup();
    const requests = recordRequests();
    const { user } = renderItem(db, items.review.id, "?tab=script");
    await screen.findByRole("region", { name: "Review" });
    await user.keyboard("a");
    await user.keyboard("r");
    expect(bodiesOf(requests, "POST", "/reviews")).toEqual([]);

    await user.click(screen.getAllByRole("button", { name: "Reject" })[0] as HTMLElement);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(bodiesOf(requests, "POST", "/reviews")).toEqual([]);

    await user.click(screen.getAllByRole("button", { name: "Reject" })[0] as HTMLElement);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Reject" }),
    );
    await waitFor(() =>
      expect(bodiesOf(requests, "POST", "/reviews")).toEqual([
        { versionId: items.review.currentVersionId, decision: "reject" },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
  });
});

describe("active job", () => {
  it("shows progress from job.activity and cancels the job", async () => {
    const { db, items } = itemSetup();
    const job = startJob(db, items.script.id);
    const requests = recordRequests();
    const { user, stream } = renderItem(db, items.script.id);
    const banner = await screen.findByRole("region", { name: "Production job" });
    expect(within(banner).getByText("Rendering the video")).toBeInTheDocument();
    await waitFor(() => expect(stream.sources.length).toBeGreaterThan(0));
    act(() =>
      stream.latest().emit({
        type: "job.activity",
        payload: { jobId: job.id, kind: "render", summary: "Encoding frames", progress: 0.4 },
      }),
    );
    expect(await within(banner).findByText("Encoding frames")).toBeInTheDocument();
    expect(within(banner).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    await user.click(within(banner).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(requests.some((r) => r.path === `/api/jobs/${job.id}/cancel`)).toBe(true),
    );
    expect(await within(banner).findByRole("button", { name: "Cancelling…" })).toBeDisabled();
  });
});

describe("script", () => {
  it("shows timestamped segments with the hook and the length against the format", async () => {
    const { db, items } = itemSetup();
    renderItem(db, items.review.id, "?tab=script");
    const segments = await screen.findByRole("list", { name: "Segments" });
    expect(within(segments).getAllByRole("listitem")[0]).toHaveTextContent(
      /^\[00:00\.0–00:0\d\.\d\]/,
    );
    expect(screen.getByText("Hook")).toBeInTheDocument();
    expect(await screen.findByText(/On target \(30–60 s\)/)).toBeInTheDocument();
  });

  it("renders a word diff between versions", async () => {
    const { db, items, reviewVersions } = itemSetup();
    renderItem(db, items.review.id, `?tab=script&compare=${reviewVersions.v4.id}`);
    const diff = await screen.findByTestId("script-diff");
    const removed = Array.from(diff.querySelectorAll("del")).map((node) =>
      node.textContent?.trim(),
    );
    const added = Array.from(diff.querySelectorAll("ins")).map((node) => node.textContent?.trim());
    expect(removed).toEqual(["refuses"]);
    expect(added).toEqual(["rejects"]);
    expect(screen.getByText("v4 → v5")).toBeInTheDocument();
    expect(screen.getByText("1 added")).toBeInTheDocument();
  });

  it("saves edits as a new version on top of the current one", async () => {
    const { db, items } = itemSetup();
    const requests = recordRequests();
    const baseId = items.script.currentVersionId;
    const { user } = renderItem(db, items.script.id, "?tab=script");
    await user.click(await screen.findByRole("button", { name: "Edit script" }));
    const first = await screen.findByRole("textbox", { name: "Segment 1 text" });
    await user.clear(first);
    await user.type(first, "A new opening line.");
    // ⌥↓ moves the segment, and focus follows it.
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(screen.getByRole("textbox", { name: "Segment 2 text" })).toHaveValue(
      "A new opening line.",
    );
    expect(screen.getByRole("textbox", { name: "Segment 2 text" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Save as new version" }));
    await waitFor(() => expect(bodiesOf(requests, "POST", "/versions")).toHaveLength(1));
    const body = bodiesOf(requests, "POST", "/versions")[0] as {
      baseVersionId: string;
      script: { segments: { text: string }[] };
    };
    expect(body.baseVersionId).toBe(baseId);
    expect(body.script.segments[1]?.text).toBe("A new opening line.");
    expect(await screen.findByRole("button", { name: "Edit script" })).toBeInTheDocument();
    expect(db.contentItems.find((item) => item.id === items.script.id)?.versionNo).toBe(3);
  });

  it("shows a conflict when another version was saved first, and saves on top", async () => {
    const { db, items } = itemSetup();
    const requests = recordRequests();
    const baseId = items.script.currentVersionId;
    const { user } = renderItem(db, items.script.id, "?tab=script");
    await user.click(await screen.findByRole("button", { name: "Edit script" }));
    const field = await screen.findByRole("textbox", { name: "Segment 1 text" });
    await user.type(field, " Edited.");

    // Another writer adds a version the page has not heard about.
    const stored = db.contentItems.find((item) => item.id === items.script.id);
    if (!stored) throw new Error("missing item");
    const newer = mockVersion({ itemId: stored.id, versionNo: 3, stage: "script" });
    db.contentVersions.push(newer);
    stored.currentVersionId = newer.id;
    stored.versionNo = 3;

    await user.click(screen.getByRole("button", { name: "Save as new version" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/newer version of this video was saved/);
    expect((field as HTMLTextAreaElement).value).toContain("Edited.");

    await user.click(within(alert).getByRole("button", { name: "Save on top" }));
    await waitFor(() => expect(bodiesOf(requests, "POST", "/versions")).toHaveLength(2));
    const bases = bodiesOf(requests, "POST", "/versions").map(
      (body) => (body as { baseVersionId: string }).baseVersionId,
    );
    expect(bases).toEqual([baseId, newer.id]);
    await waitFor(() => expect(stored.versionNo).toBe(4));
  });
});

describe("storyboard", () => {
  it("lists frames with card, tier, purpose and timing, and edits slots into a new version", async () => {
    const { db, items } = itemSetup();
    const requests = recordRequests();
    const { user } = renderItem(db, items.review.id, "?tab=storyboard");
    const frames = await screen.findByRole("list", { name: "Frames" });
    const first = within(frames).getAllByRole("listitem")[0] as HTMLElement;
    expect(within(first).getByText("vox-explainer.t1.section.circle")).toBeInTheDocument();
    expect(within(first).getByText("Tier 1")).toBeInTheDocument();
    expect(within(first).getByText("section")).toBeInTheDocument();
    expect(within(first).getByRole("img", { name: /^Plays from \[00:00\.0/ })).toBeInTheDocument();

    await user.click(within(first).getByRole("button", { name: "Edit the slots of frame 1" }));
    const headline = within(first).getByRole("textbox", { name: "headline" });
    await user.clear(headline);
    await user.type(headline, "One owner");
    await user.click(within(first).getByRole("button", { name: "Save as new version" }));
    await waitFor(() => expect(bodiesOf(requests, "POST", "/versions")).toHaveLength(1));
    const body = bodiesOf(requests, "POST", "/versions")[0] as {
      storyboard: { frames: { slots: Record<string, string> }[] };
    };
    expect(body.storyboard.frames[0]?.slots.headline).toBe("One owner");
  });
});

describe("voice takes", () => {
  it("marks the take in use and switches to another with versions.edit", async () => {
    const { db, items, reviewVersions } = itemSetup();
    const requests = recordRequests();
    const baseId = items.review.currentVersionId;
    const { user } = renderItem(db, items.review.id, "?tab=voice");
    const list = await screen.findByRole("list", { name: "Voice takes" });
    const current = within(list).getByRole("listitem", { name: "voice-v5.mp3" });
    const earlier = within(list).getByRole("listitem", { name: "voice-v4.mp3" });
    expect(within(current).getByText("In use")).toBeInTheDocument();
    expect(within(current).queryByRole("button", { name: "Use this take" })).toBeNull();

    await user.click(within(earlier).getByRole("button", { name: "Use this take" }));
    await waitFor(() =>
      expect(bodiesOf(requests, "POST", "/versions")).toEqual([
        {
          baseVersionId: baseId,
          voiceAssetId: reviewVersions.v4.voiceAssetId,
        },
      ]),
    );
    // A new take drops the render, so the item leaves review for the voice stage.
    await headerPill("Voice");
    await waitFor(() =>
      expect(
        within(screen.getByRole("listitem", { name: "voice-v4.mp3" })).getByText("In use"),
      ).toBeInTheDocument(),
    );
  });

  it("plays takes from presigned URLs that are refreshed before they expire", async () => {
    const { db, items } = itemSetup();
    let issued = 0;
    const urls = [
      http.get(`*${routes["assets.url"].path}`, ({ params }) => {
        issued += 1;
        // Expires in just over a minute, so the refresh is due straight away.
        return HttpResponse.json({
          url: `https://media.example.test/${String(params.id)}?n=${issued}`,
          expiresAt: new Date(Date.now() + 61_000).toISOString(),
        });
      }),
    ];
    // The script item has no voice yet: give it one take.
    db.assets.push(
      mockAsset({
        kind: "voice",
        projectId: items.script.projectId,
        itemId: items.script.id,
        filename: "take.mp3",
      }),
    );
    const { user } = renderItem(db, items.script.id, "", urls);
    await heading(items.script.title);
    await user.click(screen.getByRole("tab", { name: "Voice" }));
    const player = await screen.findByLabelText("Play take.mp3");
    expect(player).not.toHaveAttribute("autoplay");
    expect(player).toHaveAttribute("preload", "none");
    await waitFor(() => expect(player.getAttribute("src")).toMatch(/\?n=1$/));
    await waitFor(() => expect(player.getAttribute("src")).toMatch(/\?n=[2-9]$/), {
      timeout: 4_000,
    });
  });
});

describe("video", () => {
  it("shows the render in a player that never autoplays, with its details", async () => {
    const { db, items } = itemSetup();
    renderItem(db, items.review.id, "?tab=video");
    const video = (await screen.findByLabelText("Rendered video")) as HTMLVideoElement;
    expect(video.tagName).toBe("VIDEO");
    expect(video.autoplay).toBe(false);
    expect(video).not.toHaveAttribute("autoplay");
    await waitFor(() => expect(video.getAttribute("src")).toContain("/mock-media/"));
    await waitFor(() => expect(video.getAttribute("poster")).toContain("/mock-media/"));
    expect(await screen.findByText("1080 × 1920")).toBeInTheDocument();
    expect(screen.getByText("30 fps")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1×" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
    expect(actions()).not.toContain("Produce");
  });
});

describe("producer chat", () => {
  it("opens the item's own conversation", async () => {
    const { db, items } = itemSetup();
    renderItem(db, items.review.id, "?tab=script");
    const chat = await screen.findByRole("region", { name: "Producer chat" });
    expect(await within(chat).findByText("No messages yet")).toBeInTheDocument();
    await waitFor(() =>
      expect(db.conversations.find((c) => c.contentItemId === items.review.id)).toBeDefined(),
    );
  });
});
