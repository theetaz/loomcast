import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NO_DOWNLOAD_NOTICE } from "@/features/kb/TranscriptInput";
import { updateJob } from "@/mocks/conversations";
import { DEMO_ANALYSIS, updateKbEntry } from "@/mocks/kb";
import { kbSetup, PROJECT_SLUG, recordRequests } from "./support/kb";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";

function renderPath(db: ReturnType<typeof kbSetup>["db"], path: string) {
  const stream = fakeStream(db);
  return renderApp(path, db, [], { createEventSource: stream.factory });
}

const SRT = [
  "1",
  "00:00:00,000 --> 00:00:02,000",
  "<i>This line</i> compiles.",
  "",
  "2",
  "00:01:04,200 --> 00:01:06,000",
  "Borrow it instead.",
  "",
].join("\n");

describe("reference intake", () => {
  it("loads a subtitle file, shows the notice and saves the reference", async () => {
    const { db } = kbSetup();
    const requests = recordRequests();
    const { user, router, container } = renderPath(
      db,
      `/projects/${PROJECT_SLUG}/kb/new?kind=reference`,
    );

    expect(await screen.findByText(NO_DOWNLOAD_NOTICE)).toBeInTheDocument();
    expect(NO_DOWNLOAD_NOTICE).toBe(
      "Loomcast never downloads the video. Paste a transcript or load a file you own.",
    );

    const url = screen.getByLabelText("Link to the video");
    expect(url).toHaveFocus();
    await user.type(url, "https://www.tiktok.com/@dev/video/42?utm_source=share");
    expect(screen.getByText("https://tiktok.com/@dev/video/42")).toBeInTheDocument();
    expect(screen.getByText("TikTok")).toBeInTheDocument();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");
    await user.upload(input, new File([SRT], "clip.srt", { type: "application/x-subrip" }));
    const transcript = screen.getByLabelText(/^transcript/i);
    await waitFor(() =>
      expect(transcript).toHaveValue("[00:00] This line compiles.\n[01:04] Borrow it instead."),
    );
    expect(screen.getByText("Loaded clip.srt: 2 lines.")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/why you liked it/i), "Shows the error first.");
    await user.keyboard("{Meta>}s{/Meta}");

    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/kb\/[0-9a-f-]{36}$/));
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({
      kind: "reference",
      url: "https://www.tiktok.com/@dev/video/42?utm_source=share",
      likedReason: "Shows the error first.",
      transcript: "[00:00] This line compiles.\n[01:04] Borrow it instead.",
      tags: [],
    });
    expect(await screen.findByRole("heading", { name: "TikTok video" })).toBeInTheDocument();
  });

  it("rejects files it cannot read and links that are not http", async () => {
    const { db } = kbSetup();
    const { user, container } = renderPath(db, `/projects/${PROJECT_SLUG}/kb/new?kind=reference`);
    const input = await waitFor(() => {
      const found = container.querySelector<HTMLInputElement>('input[type="file"]');
      if (!found) throw new Error("no file input");
      return found;
    });

    await user.upload(input, new File(["{nope"], "words.json", { type: "application/json" }));
    expect(await screen.findByText("words.json is not valid JSON.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Link to the video"), "ftp://example.com/x");
    await user.click(screen.getByRole("button", { name: /save reference/i }));
    expect(screen.getByText("Enter an http or https link to the video.")).toBeInTheDocument();
    expect(db.kbEntries.filter((entry) => entry.kind === "reference")).toHaveLength(1);
  });
});

describe("reference detail", () => {
  it("links out safely and finds text in the transcript", async () => {
    const { db, reference } = kbSetup();
    const { user } = renderPath(db, `/projects/${PROJECT_SLUG}/kb/${reference.id}`);

    const link = await screen.findByRole("link", { name: /instagram\.com\/reel\/abc/ });
    expect(link).toHaveAttribute("href", "https://instagram.com/reel/abc/");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");

    const find = screen.getByRole("searchbox", { name: "Find in transcript" });
    await user.type(find, "LINE");
    expect(await screen.findByText("1 of 3")).toBeInTheDocument();
    const text = screen.getByRole("region", { name: "Transcript text" });
    expect(text.querySelectorAll("mark")).toHaveLength(3);
    expect(text.querySelector('mark[aria-current="true"]')?.textContent).toBe("line");

    await user.keyboard("{Enter}");
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    await user.keyboard("{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}");
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(text.querySelectorAll("mark")).toHaveLength(0);
  });

  it("queues an analysis and follows the job to the stored result", async () => {
    const { db, reference } = kbSetup();
    const { user } = renderPath(db, `/projects/${PROJECT_SLUG}/kb/${reference.id}`);

    expect(await screen.findByText(/Not analyzed yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Analyze" }));

    const pill = await screen.findByText("Queued");
    expect(pill).toHaveAttribute("data-status", "queued");
    expect(screen.getByRole("button", { name: "Analyze" })).toBeDisabled();
    const job = db.jobs.find((item) => item.type === "kb.analyze_reference");
    if (!job) throw new Error("no analysis job");

    act(() => {
      updateJob(db, job.id, { status: "running", startedAt: new Date().toISOString() });
    });
    expect(await screen.findByText("Analyzing")).toHaveAttribute("data-status", "running");

    act(() => {
      updateKbEntry(db, reference.id, (entry) => {
        if (!entry.reference) return;
        entry.reference.analysis = DEMO_ANALYSIS;
        entry.reference.analysisStatus = "done";
        entry.reference.analyzedAt = new Date().toISOString();
      });
      updateJob(db, job.id, { status: "succeeded", finishedAt: new Date().toISOString() });
    });

    const analysis = await screen.findByRole("region", { name: "Analysis" });
    expect(await within(analysis).findByText(DEMO_ANALYSIS.hook.text)).toBeInTheDocument();
    expect(within(analysis).getByText("Lands at 0:01")).toBeInTheDocument();
    expect(within(analysis).getByText("172")).toBeInTheDocument();
    expect(within(analysis).getByText("Open loop.")).toBeInTheDocument();
    expect(
      within(analysis).getByText("Show the error before explaining anything."),
    ).toBeInTheDocument();
    expect(screen.getByText("Analyzed", { selector: '[data-slot="status-pill"]' })).toHaveAttribute(
      "data-status",
      "succeeded",
    );
    expect(screen.getByRole("button", { name: "Re-analyze" })).toBeEnabled();
  });

  it("asks for a transcript before analysing and saves one", async () => {
    const { db, reference } = kbSetup();
    const stored = db.kbEntries.find((entry) => entry.id === reference.id);
    if (stored?.reference) stored.reference.transcript = null;
    const { user } = renderPath(db, `/projects/${PROJECT_SLUG}/kb/${reference.id}`);

    expect(
      await screen.findByText("Add a transcript to analyze this reference."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Add transcript" }));
    await user.click(screen.getByRole("textbox", { name: "Transcript" }));
    await user.paste("[00:00] Pasted by hand");
    await user.click(screen.getByRole("button", { name: "Save transcript" }));

    expect(await screen.findByText("[00:00] Pasted by hand")).toBeInTheDocument();
    expect(stored?.reference?.transcript).toBe("[00:00] Pasted by hand");
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled());
  });
});
