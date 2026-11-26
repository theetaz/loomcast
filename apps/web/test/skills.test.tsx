import type { SkillSummary, SkillUsage } from "@loomcast/contracts";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toolAnchor } from "@/features/skills/links";
import { catalogueRows, isSkillName, sortSkillFiles } from "@/features/skills/queries";
import { publisherLabel } from "@/features/skills/SkillDetail";
import { createMockDb, type MockSkillUse, mockWorkspace } from "@/mocks/db";
import { MOCK_SKILLS } from "@/mocks/formats";
import { currentPath, renderApp } from "./support/render";

const at = "2026-11-24T10:00:00.000Z";

function usage(name: string, items: number): SkillUsage {
  return { name, items, steps: ["script"], lastUsedAt: at, registry: null };
}

describe("skills catalogue logic", () => {
  it("joins registry skills with their usage and keeps the unregistered names apart", () => {
    const skills = MOCK_SKILLS as SkillSummary[];
    const { rows, unregistered } = catalogueRows(skills, [
      usage("scriptwriting", 3),
      usage("not-published", 1),
    ]);
    expect(rows.map((row) => [row.skill.name, row.items])).toEqual([
      ["error-first", 0],
      ["scriptwriting", 3],
      ["vertical-explainer", 0],
    ]);
    expect(unregistered.map((entry) => entry.name)).toEqual(["not-published"]);
  });

  it("orders SKILL.md and skill.json first and names anchors and publishers", () => {
    const files = sortSkillFiles([
      { path: "templates/hook.md", content: "" },
      { path: "skill.json", content: "{}" },
      { path: "SKILL.md", content: "" },
      { path: "notes.md", content: "" },
    ]);
    expect(files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "skill.json",
      "notes.md",
      "templates/hook.md",
    ]);
    expect(toolAnchor("cm say")).toBe("tool-cm-say");
    expect(toolAnchor("ffmpeg/x264 ")).toBe("tool-ffmpeg-x264");
    expect(isSkillName("voiceover")).toBe(true);
    expect(isSkillName("Fourier Reel")).toBe(false);
    expect(publisherLabel(null, "me")).toBe("An access token");
    expect(publisherLabel("me", "me")).toBe("You");
    expect(publisherLabel("someone", "me")).toBe("Another user");
  });
});

function skillsDb() {
  const unfolded = mockWorkspace({ name: "Unfolded", slug: "unfolded" });
  const maths = mockWorkspace({ name: "Maths is Beautiful", slug: "maths" });
  const uses: MockSkillUse[] = [
    {
      itemId: "11111111-1111-4111-8111-111111111111",
      workspaceId: unfolded.id,
      title: "How a QR code works",
      steps: [
        { key: "script", skill: "scriptwriting", tool: null },
        { key: "voice", skill: "voiceover", tool: "cm say" },
        { key: "idea", skill: null, tool: null },
      ],
      reportedAt: at,
    },
    {
      itemId: "22222222-2222-4222-8222-222222222222",
      workspaceId: maths.id,
      title: "Fourier circles",
      steps: [{ key: "render", skill: "scriptwriting", tool: "cm render" }],
      reportedAt: "2026-11-25T10:00:00.000Z",
    },
  ];
  const db = createMockDb({ signedIn: true, workspaces: [unfolded, maths] });
  db.skillUses = uses;
  return { db, unfolded, maths };
}

describe("skills pages", () => {
  it("lists every registry skill with its usage, then names not in the registry", async () => {
    const { db } = skillsDb();
    renderApp("/skills", db);
    const table = await screen.findByRole("table", { name: "Skills in the registry" });
    const row = (await within(table).findByRole("link", { name: "scriptwriting" })).closest("tr");
    expect(row).not.toBeNull();
    expect(await within(row as HTMLElement).findByText("2 items")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "vertical-explainer" })).toHaveAttribute(
      "href",
      "/skills/vertical-explainer",
    );
    const missing = await screen.findByRole("region", { name: "Not in the registry" });
    expect(within(missing).getByRole("link", { name: "voiceover" })).toBeInTheDocument();
  });

  it("shows a skill's SKILL.md as markdown, its versions and the items that used it", async () => {
    const { db } = skillsDb();
    const { router, user } = renderApp("/skills/scriptwriting", db);
    expect(await screen.findByText("Version 2 of the steps.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Steps" })).toBeInTheDocument();

    const versions = screen.getByRole("region", { name: "Versions" });
    expect(within(versions).getAllByRole("button")).toHaveLength(2);
    await user.click(within(versions).getByRole("button", { name: /v1/ }));
    expect(await screen.findByText("Version 1 of the steps.")).toBeInTheDocument();
    expect(currentPath(router)).toBe("/skills/scriptwriting?version=1");

    await user.click(screen.getByRole("tab", { name: "skill.json" }));
    expect(await screen.findByText(/"kind": "skill"/)).toBeInTheDocument();

    const used = screen.getByRole("region", { name: "Used in" });
    expect(await within(used).findByRole("link", { name: "Fourier circles" })).toHaveAttribute(
      "href",
      "/w/maths/content/22222222-2222-4222-8222-222222222222",
    );
    expect(within(used).getByRole("link", { name: "How a QR code works" })).toBeInTheDocument();
  });

  it("explains a reported skill that is not in the registry", async () => {
    const { db } = skillsDb();
    renderApp("/skills/voiceover", db);
    expect(await screen.findByText(/no version of it has been published/)).toBeInTheDocument();
    const used = screen.getByRole("region", { name: "Used in" });
    expect(await within(used).findByText("How a QR code works")).toBeInTheDocument();
  });

  it("lists only the open workspace's skills and tools", async () => {
    const { db } = skillsDb();
    renderApp("/w/unfolded/skills", db);
    const skills = await screen.findByRole("table", { name: "Skills used in this workspace" });
    expect(within(skills).getByRole("link", { name: "scriptwriting" })).toHaveAttribute(
      "href",
      "/skills/scriptwriting",
    );
    expect(within(skills).getByText("skill v2")).toBeInTheDocument();
    expect(within(skills).getByText("Not in the registry")).toBeInTheDocument();
    const tools = screen.getByRole("table", { name: "Tools used in this workspace" });
    expect(within(tools).getByText("cm say").closest("tr")).toHaveAttribute("id", "tool-cm-say");
    expect(within(tools).queryByText("cm render")).not.toBeInTheDocument();
  });
});
