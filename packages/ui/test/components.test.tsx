// @vitest-environment jsdom
import { Button } from "@loomcast/ui/components/button";
import {
  STATUS_STYLES,
  StatusDot,
  StatusPill,
  statusStyle,
} from "@loomcast/ui/components/StatusPill";
import { SidebarProvider, useSidebar } from "@loomcast/ui/components/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installMatchMedia } from "./support/match-media";

beforeEach(() => {
  installMatchMedia();
});
afterEach(cleanup);

describe("Button", () => {
  it("is pressable and carries its variant", () => {
    render(<Button variant="outline">Preview</Button>);
    const button = screen.getByRole("button", { name: "Preview" });
    expect(button.className).toContain("pressable");
    expect(button.className).toContain("shadow-card");
    expect(button.dataset.variant).toBe("outline");
  });

  it("merges caller classes over its own", () => {
    render(<Button className="h-10">Tall</Button>);
    const button = screen.getByRole("button", { name: "Tall" });
    expect(button.className).toContain("h-10");
    expect(button.className).not.toContain("h-7.5");
  });
});

describe("StatusPill", () => {
  it("maps every pipeline, job, device, post and channel status to a brand tone", () => {
    const tones = new Set(["gray", "amber", "violet", "blue", "green", "red"]);
    for (const entries of Object.values(STATUS_STYLES)) {
      for (const { tone } of Object.values(entries)) expect(tones.has(tone)).toBe(true);
    }
  });

  it("maps the pipeline states to their tones and labels", () => {
    expect(STATUS_STYLES.pipeline).toEqual({
      idea: { label: "Idea", tone: "gray" },
      script: { label: "Script", tone: "amber" },
      storyboard: { label: "Storyboard", tone: "amber" },
      voice: { label: "Voice", tone: "violet" },
      render: { label: "Render", tone: "violet" },
      review: { label: "In review", tone: "amber" },
      approved: { label: "Approved", tone: "green" },
      scheduled: { label: "Scheduled", tone: "blue" },
      published: { label: "Published", tone: "green" },
      archived: { label: "Archived", tone: "gray" },
    });
  });

  it("labels review as waiting for a person", () => {
    render(<StatusPill kind="pipeline" status="review" />);
    const pill = screen.getByText("In review");
    expect(pill.dataset.status).toBe("review");
    expect(pill.dataset.tone).toBe("amber");
  });

  it("follows the brand prototype colours for jobs and devices", () => {
    expect(statusStyle("job", "running").tone).toBe("violet");
    expect(statusStyle("device", "online").tone).toBe("green");
  });

  it("renders the label in the tone colour", () => {
    render(<StatusPill kind="job" status="succeeded" />);
    const pill = screen.getByText("Succeeded");
    expect(pill.dataset.tone).toBe("green");
    expect(pill.className).toContain("text-status-green");
    expect(pill.className).toContain("bg-status-green/11");
  });

  it("maps post statuses: waiting gray, queued blue, publishing violet, missed and failed red", () => {
    expect(STATUS_STYLES.post).toEqual({
      planned: { label: "Planned", tone: "gray" },
      queued: { label: "Queued", tone: "blue" },
      publishing: { label: "Publishing", tone: "violet" },
      published: { label: "Published", tone: "green" },
      failed: { label: "Failed", tone: "red" },
      cancelled: { label: "Cancelled", tone: "gray" },
      missed: { label: "Missed", tone: "red" },
    });
    render(<StatusPill kind="post" status="missed" />);
    const pill = screen.getByText("Missed");
    expect(pill.dataset.kind).toBe("post");
    expect(pill.className).toContain("text-status-red");
  });

  it("maps channel statuses: active green, reconnect amber, the rest gray", () => {
    expect(STATUS_STYLES.channel).toEqual({
      active: { label: "Active", tone: "green" },
      needs_reauth: { label: "Needs reconnect", tone: "amber" },
      disconnected: { label: "Not connected", tone: "gray" },
      disabled: { label: "Disabled", tone: "gray" },
    });
    render(<StatusPill kind="channel" status="needs_reauth" />);
    expect(screen.getByText("Needs reconnect").dataset.tone).toBe("amber");
  });

  it("draws a status dot in the tone colour, hidden from screen readers", () => {
    const { container } = render(<StatusDot kind="post" status="queued" />);
    const dot = container.querySelector<HTMLElement>("[data-slot=status-dot]");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.dataset.tone).toBe("blue");
    expect(dot?.className).toContain("bg-status-blue");
  });

  it("falls back to a neutral pill for a status it does not know", () => {
    const unknown = "paused" as "queued";
    render(<StatusPill kind="job" status={unknown} />);
    expect(screen.getByText("paused").dataset.tone).toBe("gray");
  });
});

describe("Tabs", () => {
  function renderTabs(variant?: "default" | "line") {
    return render(
      <Tabs defaultValue="all">
        <TabsList variant={variant}>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="drafts">Drafts</TabsTrigger>
        </TabsList>
        <TabsContent value="all">Everything</TabsContent>
        <TabsContent value="drafts">Drafts only</TabsContent>
      </Tabs>,
    );
  }

  it("places one indicator under the active tab", () => {
    const { container } = renderTabs();
    const indicator = container.querySelector<HTMLElement>("[data-slot=tabs-indicator]");
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute("aria-hidden")).toBe("true");
    expect(indicator?.dataset.ready).toBe("");
    expect(indicator?.className).toContain("duration-tabs");
    expect(indicator?.className).toContain("motion-reduce:transition-none");
  });

  it("keeps the indicator positioned after a change and leaves transitions on", async () => {
    const { container } = renderTabs();
    const indicator = container.querySelector<HTMLElement>("[data-slot=tabs-indicator]");
    fireEvent.pointerDown(screen.getByRole("tab", { name: "Drafts" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Drafts" }));
    await act(async () => {});
    expect(screen.getByRole("tab", { name: "Drafts" }).dataset.state).toBe("active");
    expect(indicator?.style.transition).toBe("");
    expect(indicator?.style.transform).toMatch(/^translate\(/);
  });

  it("uses an underline instead of the indicator in the line variant", () => {
    const { container } = renderTabs("line");
    expect(container.querySelector("[data-slot=tabs-indicator]")).toBeNull();
  });
});

describe("SidebarProvider", () => {
  beforeEach(() => window.localStorage.clear());

  function State() {
    const { state } = useSidebar();
    return <output>{state}</output>;
  }

  it("toggles on Ctrl+B without leaving transitions disabled", () => {
    const { container } = render(
      <SidebarProvider>
        <State />
      </SidebarProvider>,
    );
    const wrapper = container.querySelector<HTMLElement>("[data-slot=sidebar-wrapper]");
    expect(screen.getByRole("status").textContent).toBe("expanded");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });

    expect(screen.getByRole("status").textContent).toBe("collapsed");
    expect(wrapper?.dataset.instant).toBeUndefined();
  });

  it("remembers the last state in localStorage", () => {
    window.localStorage.setItem("loomcast-sidebar", "false");
    render(
      <SidebarProvider>
        <State />
      </SidebarProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("collapsed");
  });
});
