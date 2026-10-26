import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  adminTools,
  calendarTools,
  DEFAULT_FORMAT_RULES,
  kbTools,
  MCP_JOB_TOKEN_POLICIES,
  MCP_TOKEN_SCOPES,
  MCP_WORKSPACE_BINDINGS,
  mcpTools,
  ownerTools,
  PostOptionsSchema,
  pipelineTools,
  postFormatCatalog,
  postTools,
  workspaceTools,
} from "../src";
import {
  alignment,
  analysis,
  asset,
  at,
  channel,
  contentItem,
  fakeSecret,
  ids,
  kbEntry,
  post,
  script,
  storyboard,
  version,
} from "./fixtures";

const tools = Object.entries(mcpTools);

describe("mcp tool contracts", () => {
  it("collects every tool once", () => {
    const names = [
      workspaceTools,
      kbTools,
      adminTools,
      pipelineTools,
      calendarTools,
      ownerTools,
      postTools,
    ].flatMap((group) => Object.keys(group));

    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(mcpTools).sort()).toEqual(names.sort());
  });

  it.each(tools)("%s is described completely", (key, tool) => {
    expect(tool.name).toBe(key);
    expect(MCP_TOKEN_SCOPES).toContain(tool.scope);
    expect(MCP_JOB_TOKEN_POLICIES).toContain(tool.jobTokens);
    expect(MCP_WORKSPACE_BINDINGS).toContain(tool.workspaceBinding);
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it.each(tools)("%s converts to JSON Schema", (_key, tool) => {
    expect(() => z.toJSONSchema(tool.input, { io: "input" })).not.toThrow();
    expect(() => z.toJSONSchema(tool.output)).not.toThrow();
  });

  it("lets job tokens use the knowledge base and production tools, but not create workspaces or users or publish skills", () => {
    const allowed = tools
      .filter(([, tool]) => tool.jobTokens === "allow")
      .map(([name]) => name)
      .sort();

    expect(allowed).toEqual([
      "asset.get_url",
      "calendar.get_slots",
      "content.create_idea",
      "content.finalize_asset",
      "content.get",
      "content.submit_for_review",
      "content.upload_asset",
      "format.get_rules",
      "kb.add_decision",
      "kb.add_reference",
      "kb.get",
      "kb.save_brainstorm",
      "kb.search",
      "post.formats",
      "skill.pull",
      "workspace.get",
      "workspace.list",
    ]);
  });

  it("binds a workspace through the input wherever one is named", () => {
    for (const [name, tool] of tools) {
      const fields = Object.keys(tool.input.shape);
      const namesWorkspace = [
        "workspaceId",
        "idOrSlug",
        "entryId",
        "seriesId",
        "itemId",
        "assetId",
      ].some((field) => fields.includes(field));

      expect([name, tool.workspaceBinding]).toEqual([name, namesWorkspace ? "input" : "none"]);
    }
  });

  it("keeps the expected scopes", () => {
    expect(kbTools["kb.search"].scope).toBe("mcp:read");
    expect(kbTools["kb.get"].scope).toBe("mcp:read");
    expect(kbTools["kb.save_brainstorm"].scope).toBe("mcp:write");
    expect(kbTools["kb.save_session_summary"].scope).toBe("mcp:write");
    expect(adminTools["admin.create_user"].scope).toBe("mcp:admin");
    expect(pipelineTools["format.get_rules"].scope).toBe("mcp:read");
    expect(pipelineTools["content.get"].scope).toBe("mcp:read");
    expect(pipelineTools["asset.get_url"].scope).toBe("mcp:read");
    expect(pipelineTools["skill.pull"].scope).toBe("mcp:read");
    expect(pipelineTools["content.create_idea"].scope).toBe("mcp:write");
    expect(pipelineTools["content.submit_for_review"].scope).toBe("mcp:write");
    expect(pipelineTools["content.upload_asset"].scope).toBe("mcp:write");
    expect(pipelineTools["content.finalize_asset"].scope).toBe("mcp:write");
    expect(pipelineTools["skill.publish"].scope).toBe("mcp:write");
    expect(calendarTools["calendar.get_slots"].scope).toBe("mcp:read");
  });
});

describe("pipeline tools", () => {
  it("gets format rules by series", () => {
    const { input, output } = pipelineTools["format.get_rules"];
    const rules = {
      formatId: ids.format,
      name: "Rust shorts",
      formatVersionId: ids.formatVersion,
      version: 2,
      rules: DEFAULT_FORMAT_RULES,
    };

    expect(input.safeParse({ seriesId: ids.series }).success).toBe(true);
    expect(input.safeParse({}).success).toBe(false);
    expect(output.parse(rules)).toEqual(rules);
  });

  it("creates an idea with a pitch", () => {
    const { input, output } = pipelineTools["content.create_idea"];
    const idea = { workspaceId: ids.workspace, title: "Lifetimes", pitch: "Why 'a exists." };

    expect(input.safeParse(idea).success).toBe(true);
    expect(input.safeParse({ ...idea, pitch: " " }).success).toBe(false);
    expect(input.safeParse({ ...idea, seriesId: "rust" }).success).toBe(false);
    expect(output.parse({ itemId: ids.item })).toEqual({ itemId: ids.item });
  });

  it("gets an item with a version and its format", () => {
    const { input, output } = pipelineTools["content.get"];
    const got = {
      item: contentItem,
      version,
      format: { formatVersionId: ids.formatVersion, rules: DEFAULT_FORMAT_RULES },
    };

    expect(input.safeParse({ itemId: ids.item, versionId: ids.version }).success).toBe(true);
    expect(output.parse(got)).toEqual(got);
    expect(output.safeParse({ ...got, format: null }).success).toBe(true);
  });

  it("submits a script or storyboard, never an approval", () => {
    const { input, output } = pipelineTools["content.submit_for_review"];

    expect(input.safeParse({ itemId: ids.item, script }).success).toBe(true);
    expect(input.safeParse({ itemId: ids.item, storyboard, notes: "Tighter." }).success).toBe(true);
    expect(input.safeParse({ itemId: ids.item, notes: "Only notes." }).success).toBe(false);
    expect(
      input.safeParse({ itemId: ids.item, renderAssetId: ids.version, posterAssetId: ids.item })
        .success,
    ).toBe(true);
    expect(input.safeParse({ itemId: ids.item, posterAssetId: ids.version }).success).toBe(false);
    expect(input.shape).not.toHaveProperty("state");
    expect(output.parse({ versionId: ids.version, versionNo: 2, state: "script" })).toEqual({
      versionId: ids.version,
      versionNo: 2,
      state: "script",
    });
  });

  it("uploads, finalizes and links assets with the REST rules", () => {
    const upload = pipelineTools["content.upload_asset"];
    const request = {
      itemId: ids.item,
      kind: "voice",
      filename: "voice.mp3",
      mime: "audio/mpeg",
      bytes: 1_234_567,
      sha256: "c".repeat(64),
    };

    expect(upload.input.safeParse(request).success).toBe(true);
    expect(upload.input.safeParse({ ...request, mime: "video/mp4" }).success).toBe(false);
    expect(upload.input.safeParse({ ...request, bytes: 101 * 1024 * 1024 }).success).toBe(false);
    expect(upload.output.safeParse({ asset, upload: null }).success).toBe(true);

    const finalize = pipelineTools["content.finalize_asset"];
    expect(
      finalize.input.safeParse({ assetId: ids.voice, probe: { durationMs: 41_000 }, alignment })
        .success,
    ).toBe(true);
    expect(finalize.input.safeParse({ probe: {} }).success).toBe(false);

    const url = pipelineTools["asset.get_url"];
    expect(url.input.safeParse({ assetId: ids.render, disposition: "attachment" }).success).toBe(
      true,
    );
    expect(
      url.output.safeParse({
        url: "https://media.example.test/a.mp4",
        expiresAt: at,
        asset: { ...asset, alignment: null },
      }).success,
    ).toBe(true);
  });

  it("pulls and publishes skills", () => {
    const pull = pipelineTools["skill.pull"];
    const publish = pipelineTools["skill.publish"];
    const files = [{ path: "SKILL.md", content: "# Scriptwriting" }];

    expect(pull.input.safeParse({}).success).toBe(true);
    expect(pull.input.safeParse({ name: "scriptwriting", version: 2 }).success).toBe(true);
    expect(pull.input.safeParse({ version: 2 }).success).toBe(false);
    expect(
      pull.output.safeParse({
        skills: [
          { name: "scriptwriting", kind: "skill", version: 2, checksum: "d".repeat(64), files },
        ],
      }).success,
    ).toBe(true);
    expect(publish.input.safeParse({ name: "scriptwriting", kind: "skill", files }).success).toBe(
      true,
    );
    expect(
      publish.input.safeParse({
        name: "scriptwriting",
        kind: "skill",
        files: [{ path: "../../.ssh/config", content: "x" }],
      }).success,
    ).toBe(false);
    expect(
      publish.output.parse({
        name: "scriptwriting",
        version: 2,
        checksum: "d".repeat(64),
        created: false,
      }).created,
    ).toBe(false);
  });
});

describe("calendar tools", () => {
  it("reads slots of a series or channel, bound to a workspace", () => {
    const { input, output, workspaceBinding } = calendarTools["calendar.get_slots"];
    const range = { from: "2026-10-12T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" };
    const slots = [
      { at: "2026-10-12T13:00:00.000Z", seriesId: ids.series, channelId: ids.channel },
      {
        at: "2026-10-14T13:00:00.000Z",
        seriesId: ids.series,
        channelId: ids.channel,
        postId: ids.post,
      },
    ];

    expect(workspaceBinding).toBe("input");
    expect(input.safeParse(range).success).toBe(true);
    expect(
      input.safeParse({ ...range, seriesId: ids.series, channelId: ids.channel }).success,
    ).toBe(true);
    expect(input.safeParse({ ...range, workspaceId: ids.workspace }).success).toBe(true);
    expect(input.safeParse({ ...range, seriesId: "rust" }).success).toBe(false);
    expect(input.safeParse({ from: range.from }).success).toBe(false);
    expect(output.parse({ slots })).toEqual({ slots });
    expect(output.safeParse({ slots: [{ ...slots[0], postId: null }] }).success).toBe(false);
  });
});

describe("kb tools", () => {
  it("saves a brainstorm and returns its link", () => {
    const { input, output } = kbTools["kb.save_brainstorm"];
    const brainstorm = {
      workspaceId: ids.workspace,
      title: "Hooks",
      bodyMd: "- result first",
      tags: ["Hooks"],
      sessionRef: "session-1",
    };

    expect(input.parse(brainstorm)).toEqual({ ...brainstorm, tags: ["hooks"] });
    expect(input.safeParse({ ...brainstorm, bodyMd: "  " }).success).toBe(false);
    expect(input.safeParse({ ...brainstorm, workspaceId: "rust" }).success).toBe(false);
    expect(
      output.safeParse({ entryId: ids.entry, url: "https://loomcast.example.test/kb/1" }).success,
    ).toBe(true);
  });

  it("adds a reference with an optional platform and analysis", () => {
    const { input, output } = kbTools["kb.add_reference"];
    const reference = { workspaceId: ids.workspace, url: "https://youtu.be/abc?si=x" };

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
      input.safeParse({ workspaceId: ids.workspace, title: "Format", decision: "Vertical only" })
        .success,
    ).toBe(true);
    expect(input.safeParse({ workspaceId: ids.workspace, title: "Format" }).success).toBe(false);
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
      workspaceId: ids.workspace,
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

  it("saves a session summary with or without a workspace", () => {
    const { input } = kbTools["kb.save_session_summary"];

    expect(input.safeParse({ sessionId: "s1", summaryMd: "Did things", cwd: "/w" }).success).toBe(
      true,
    );
    expect(
      input.safeParse({ workspaceId: ids.workspace, sessionId: "s1", summaryMd: "Did things" })
        .success,
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

describe("owner tools", () => {
  it("need mcp:admin and are never open to job tokens", () => {
    for (const tool of Object.values(ownerTools)) {
      expect([tool.name, tool.scope, tool.jobTokens]).toEqual([tool.name, "mcp:admin", "deny"]);
      expect(tool.description.startsWith("Owner only.")).toBe(true);
    }
  });

  it("decides a review with the REST rules", () => {
    const { input, output } = ownerTools["content.review"];
    const base = { itemId: ids.item, versionId: ids.version };
    const decided = {
      reviewId: ids.post,
      itemId: ids.item,
      decision: "approve",
      state: "approved",
    };

    expect(input.safeParse({ ...base, decision: "approve" }).success).toBe(true);
    expect(input.safeParse({ ...base, decision: "request_changes" }).success).toBe(false);
    expect(
      input.safeParse({ ...base, decision: "request_changes", comment: "Shorter hook." }).success,
    ).toBe(true);
    expect(input.safeParse({ ...base, decision: "approve", enqueueRevision: false }).success).toBe(
      false,
    );
    expect(input.safeParse({ versionId: ids.version, decision: "approve" }).success).toBe(false);
    expect(output.parse(decided)).toEqual(decided);
  });

  it("lists channels without credentials", () => {
    const { output } = ownerTools["channel.list"];
    expect(output.parse({ channels: [{ ...channel, secret: fakeSecret("token") }] })).toEqual({
      channels: [channel],
    });
  });

  it("lists, schedules, moves and cancels posts", () => {
    const range = { from: "2026-10-12T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" };
    const list = ownerTools["calendar.list_posts"].input;
    const schedule = ownerTools["calendar.schedule_post"].input;
    const reschedule = ownerTools["calendar.reschedule_post"].input;
    const cancel = ownerTools["calendar.cancel_post"].input;

    expect(list.safeParse({ ...range, channelIds: [ids.channel] }).success).toBe(true);
    expect(list.safeParse({ ...range, channelIds: [ids.channel, ids.channel] }).success).toBe(
      false,
    );
    expect(list.safeParse({ ...range, to: "2027-01-01T00:00:00.000Z" }).success).toBe(false);
    expect(ownerTools["calendar.list_posts"].output.parse({ posts: [post], slots: [] })).toEqual({
      posts: [post],
      slots: [],
    });
    expect(
      schedule.safeParse({ itemId: ids.item, channelId: ids.channel, scheduledAt: at }).success,
    ).toBe(true);
    expect(
      reschedule.safeParse({ postId: ids.post, scheduledAt: at, expectedUpdatedAt: at }).success,
    ).toBe(true);
    expect(reschedule.safeParse({ postId: ids.post, scheduledAt: at }).success).toBe(false);
    expect(cancel.safeParse({ postId: ids.post }).success).toBe(true);
    expect(ownerTools["calendar.cancel_post"].output.parse({ post })).toEqual({ post });
  });
});

describe("post tools", () => {
  it("keep composing and scheduling to the owner", () => {
    for (const tool of Object.values(postTools)) {
      if (tool.name === "post.formats") {
        expect([tool.scope, tool.jobTokens]).toEqual(["mcp:read", "allow"]);
        continue;
      }
      expect([tool.name, tool.scope, tool.jobTokens]).toEqual([tool.name, "mcp:admin", "deny"]);
      expect(tool.description.startsWith("Owner only.")).toBe(true);
    }
  });

  it("list every format, platform and option from the format tables", () => {
    const catalog = postTools["post.formats"].output.parse(postFormatCatalog());
    expect(catalog.formats.map((entry) => entry.format)).toEqual([
      "reel",
      "video",
      "image",
      "carousel",
      "story",
      "text",
    ]);
    expect(catalog.formats.find((entry) => entry.format === "text")).toMatchObject({
      label: "Text post",
      min: 0,
      max: 0,
      platforms: ["facebook"],
    });
    expect(catalog.platforms.find((entry) => entry.platform === "instagram")?.formats).toEqual([
      "reel",
      "image",
      "carousel",
      "story",
    ]);
    expect(catalog.photoOnlyCarouselPlatforms).toEqual(["facebook"]);
    // Every documented option is a field of the options schema, and every field is documented.
    const shapes = {
      instagram: Object.keys(PostOptionsSchema.shape.instagram.unwrap().shape),
      facebook: Object.keys(PostOptionsSchema.shape.facebook.unwrap().shape),
    };
    for (const platform of ["instagram", "facebook"] as const) {
      expect(
        catalog.options
          .filter((option) => option.platform === platform)
          .map((option) => option.field)
          .sort(),
      ).toEqual(shapes[platform].sort());
    }
  });

  it("validate composing and scheduling input", () => {
    const create = postTools["post.create"].input;
    const compose = postTools["post.compose"].input;
    const schedule = postTools["post.schedule"].input;

    expect(
      create.safeParse({ workspaceId: ids.workspace, title: "Launch", format: "image" }).success,
    ).toBe(true);
    expect(create.safeParse({ workspaceId: ids.workspace, title: "Launch" }).success).toBe(false);
    expect(
      create.safeParse({ workspaceId: ids.workspace, title: "x", format: "gif" }).success,
    ).toBe(false);

    expect(compose.safeParse({ itemId: ids.item }).success).toBe(false);
    expect(compose.safeParse({ itemId: ids.item, caption: null }).success).toBe(true);
    expect(
      compose.safeParse({ itemId: ids.item, media: [{ assetId: ids.asset, altText: "A cat" }] })
        .success,
    ).toBe(true);
    expect(
      compose.safeParse({
        itemId: ids.item,
        media: [{ assetId: ids.asset }, { assetId: ids.asset }],
      }).success,
    ).toBe(false);
    expect(
      compose.safeParse({ itemId: ids.item, media: [{ assetId: ids.asset, type: "image" }] }).data
        ?.media,
    ).toEqual([{ assetId: ids.asset }]);

    const base = { itemId: ids.item, scheduledAt: at };
    expect(schedule.safeParse({ ...base, channelIds: [ids.channel] }).success).toBe(true);
    expect(schedule.safeParse({ ...base, channelIds: [] }).success).toBe(false);
    expect(schedule.safeParse({ ...base, channelIds: [ids.channel, ids.channel] }).success).toBe(
      false,
    );
    expect(
      schedule.safeParse({
        ...base,
        channelIds: [ids.channel],
        options: { facebook: { link: "https://example.com/launch" } },
      }).success,
    ).toBe(true);
    expect(
      schedule.safeParse({ ...base, channelIds: [ids.channel], options: { threads: {} } }).success,
    ).toBe(false);
    expect(
      postTools["post.schedule"].output.parse({
        ...base,
        versionId: ids.version,
        state: "scheduled",
        reviewId: null,
        posts: [post],
      }),
    ).toMatchObject({ posts: [post] });
  });
});
