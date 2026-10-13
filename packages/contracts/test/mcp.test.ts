import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  adminTools,
  kbTools,
  MCP_JOB_TOKEN_POLICIES,
  MCP_PROJECT_BINDINGS,
  MCP_TOKEN_SCOPES,
  mcpTools,
  projectTools,
} from "../src";
import { analysis, at, fakeSecret, ids, kbEntry } from "./fixtures";

const tools = Object.entries(mcpTools);

describe("mcp tool contracts", () => {
  it("collects every tool once", () => {
    const names = [projectTools, kbTools, adminTools].flatMap((group) => Object.keys(group));

    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(mcpTools).sort()).toEqual(names.sort());
  });

  it.each(tools)("%s is described completely", (key, tool) => {
    expect(tool.name).toBe(key);
    expect(MCP_TOKEN_SCOPES).toContain(tool.scope);
    expect(MCP_JOB_TOKEN_POLICIES).toContain(tool.jobTokens);
    expect(MCP_PROJECT_BINDINGS).toContain(tool.projectBinding);
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it.each(tools)("%s converts to JSON Schema", (_key, tool) => {
    expect(() => z.toJSONSchema(tool.input, { io: "input" })).not.toThrow();
    expect(() => z.toJSONSchema(tool.output)).not.toThrow();
  });

  it("lets job tokens read and write the knowledge base but not create projects or users", () => {
    const allowed = tools
      .filter(([, tool]) => tool.jobTokens === "allow")
      .map(([name]) => name)
      .sort();

    expect(allowed).toEqual([
      "kb.add_decision",
      "kb.add_reference",
      "kb.get",
      "kb.save_brainstorm",
      "kb.search",
      "project.get",
      "project.list",
    ]);
  });

  it("binds a project through the input wherever one is named", () => {
    for (const [name, tool] of tools) {
      const fields = Object.keys(tool.input.shape);
      const namesProject = ["projectId", "idOrSlug", "entryId"].some((field) =>
        fields.includes(field),
      );

      expect([name, tool.projectBinding]).toEqual([name, namesProject ? "input" : "none"]);
    }
  });

  it("keeps the expected scopes", () => {
    expect(kbTools["kb.search"].scope).toBe("mcp:read");
    expect(kbTools["kb.get"].scope).toBe("mcp:read");
    expect(kbTools["kb.save_brainstorm"].scope).toBe("mcp:write");
    expect(kbTools["kb.save_session_summary"].scope).toBe("mcp:write");
    expect(adminTools["admin.create_user"].scope).toBe("mcp:admin");
  });
});

describe("kb tools", () => {
  it("saves a brainstorm and returns its link", () => {
    const { input, output } = kbTools["kb.save_brainstorm"];
    const brainstorm = {
      projectId: ids.project,
      title: "Hooks",
      bodyMd: "- result first",
      tags: ["Hooks"],
      sessionRef: "session-1",
    };

    expect(input.parse(brainstorm)).toEqual({ ...brainstorm, tags: ["hooks"] });
    expect(input.safeParse({ ...brainstorm, bodyMd: "  " }).success).toBe(false);
    expect(input.safeParse({ ...brainstorm, projectId: "rust" }).success).toBe(false);
    expect(
      output.safeParse({ entryId: ids.entry, url: "https://loomcast.example.test/kb/1" }).success,
    ).toBe(true);
  });

  it("adds a reference with an optional platform and analysis", () => {
    const { input, output } = kbTools["kb.add_reference"];
    const reference = { projectId: ids.project, url: "https://youtu.be/abc?si=x" };

    expect(input.safeParse(reference).success).toBe(true);
    expect(input.safeParse({ ...reference, platform: "youtube", analysis }).success).toBe(true);
    expect(input.safeParse({ ...reference, platform: "vimeo" }).success).toBe(false);
    expect(input.safeParse({ ...reference, url: "javascript:alert(1)" }).success).toBe(false);
    expect(input.safeParse({ ...reference, analysis: { hook: analysis.hook } }).success).toBe(
      false,
    );
    expect(output.parse({ entryId: ids.entry })).toEqual({ entryId: ids.entry });
  });

  it("records a decision", () => {
    const { input } = kbTools["kb.add_decision"];

    expect(
      input.safeParse({ projectId: ids.project, title: "Format", decision: "Vertical only" })
        .success,
    ).toBe(true);
    expect(input.safeParse({ projectId: ids.project, title: "Format" }).success).toBe(false);
  });

  it("searches with a bounded query and limit", () => {
    const { input, output } = kbTools["kb.search"];

    expect(input.parse({ query: " hooks ", kinds: ["brainstorm"], limit: 50 })).toEqual({
      query: "hooks",
      kinds: ["brainstorm"],
      limit: 50,
    });
    expect(input.safeParse({ query: "hooks", limit: 51 }).success).toBe(false);
    expect(input.safeParse({ query: "" }).success).toBe(false);
    expect(input.safeParse({ query: "hooks", kinds: [] }).success).toBe(false);
    const hit = {
      entryId: ids.entry,
      projectId: ids.project,
      kind: "decision",
      title: "Format",
      snippet: "\u0002vertical\u0003 only",
      score: 1,
    };
    expect(output.parse({ hits: [hit] })).toEqual({ hits: [hit] });
  });

  it("gets an entry with its details", () => {
    const { input, output } = kbTools["kb.get"];

    expect(input.safeParse({ entryId: ids.entry }).success).toBe(true);
    expect(output.safeParse({ entry: { ...kbEntry, reference: null } }).success).toBe(true);
  });

  it("saves a session summary with or without a project", () => {
    const { input } = kbTools["kb.save_session_summary"];

    expect(input.safeParse({ sessionId: "s1", summaryMd: "Did things", cwd: "/w" }).success).toBe(
      true,
    );
    expect(
      input.safeParse({ projectId: ids.project, sessionId: "s1", summaryMd: "Did things" }).success,
    ).toBe(true);
    expect(input.safeParse({ sessionId: "", summaryMd: "x" }).success).toBe(false);
  });
});

describe("admin tools", () => {
  it("creates a user and returns a set-password link, never a password", () => {
    const { input, output } = adminTools["admin.create_user"];
    const created = {
      userId: ids.user,
      setPasswordUrl: "https://loomcast.example.test/set-password#token",
      expiresAt: at,
    };

    expect(input.parse({ email: "New@Example.test", name: "New", role: "admin" })).toEqual({
      email: "new@example.test",
      name: "New",
      role: "admin",
    });
    expect(output.parse({ ...created, password: fakeSecret("password") })).toEqual(created);
    expect(output.safeParse({ ...created, setPasswordUrl: "set-password" }).success).toBe(false);
  });
});
