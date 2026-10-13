import { describe, expect, it } from "vitest";
import {
  ASSET_KIND_MAX_BYTES,
  ASSET_KIND_MIME_TYPES,
  ASSET_KINDS,
  ASSET_MIME_TYPES,
  AssetDetailSchema,
  AssetFilenameSchema,
  ContentActionRequestSchema,
  ContentItemDetailSchema,
  CreateContentItemRequestSchema,
  CreateFormatRequestSchema,
  CreateReviewRequestSchema,
  CreateUploadRequestSchema,
  CreateUploadResponseSchema,
  DEFAULT_FORMAT_RULES,
  EditVersionRequestSchema,
  FormatSchema,
  isSkillPath,
  ListContentQuerySchema,
  routes,
  SKILL_MAX_BYTES,
  SKILL_MAX_FILES,
  SkillFilesSchema,
  SkillManifestSchema,
  skillChecksumInput,
  UpdateContentItemRequestSchema,
  UpdateFormatRequestSchema,
  UpdateSeriesRequestSchema,
} from "../src";
import { alignment, asset, at, contentItem, ids, job, script, version } from "./fixtures";

describe("formats and series", () => {
  it("creates a format from the defaults or given rules", () => {
    expect(CreateFormatRequestSchema.parse({ name: " Rust shorts " })).toEqual({
      name: "Rust shorts",
    });
    expect(
      CreateFormatRequestSchema.safeParse({ name: "Rust", rules: DEFAULT_FORMAT_RULES }).success,
    ).toBe(true);
    expect(
      CreateFormatRequestSchema.safeParse({
        name: "Rust",
        rules: { ...DEFAULT_FORMAT_RULES, lengthSec: { min: 60, max: 30 } },
      }).success,
    ).toBe(false);
  });

  it("updates a format against the version the client edited", () => {
    expect(UpdateFormatRequestSchema.safeParse({ baseVersionId: ids.formatVersion }).success).toBe(
      false,
    );
    expect(
      UpdateFormatRequestSchema.safeParse({ baseVersionId: ids.formatVersion, name: "Shorts" })
        .success,
    ).toBe(true);
    expect(UpdateFormatRequestSchema.safeParse({ name: "Shorts" }).success).toBe(false);
  });

  it("returns a format with its current version", () => {
    const format = {
      id: ids.format,
      projectId: ids.project,
      name: "Rust shorts",
      slug: "rust-shorts",
      currentVersion: {
        id: ids.formatVersion,
        formatId: ids.format,
        versionNo: 2,
        rules: DEFAULT_FORMAT_RULES,
        createdBy: ids.user,
        createdAt: at,
      },
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
    };

    expect(FormatSchema.parse(format)).toEqual(format);
  });

  it("rejects an empty series update", () => {
    expect(UpdateSeriesRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateSeriesRequestSchema.safeParse({ formatId: ids.format }).success).toBe(true);
  });
});

describe("content items and versions", () => {
  it("creates an idea", () => {
    expect(
      CreateContentItemRequestSchema.parse({ title: " Lifetimes ", seriesId: ids.series }),
    ).toEqual({ title: "Lifetimes", seriesId: ids.series });
    expect(CreateContentItemRequestSchema.safeParse({ title: "" }).success).toBe(false);
    expect(UpdateContentItemRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateContentItemRequestSchema.safeParse({ pitch: null }).success).toBe(true);
  });

  it("lists with state, series, search and target filters from a query string", () => {
    expect(
      ListContentQuerySchema.parse({
        states: "idea,review",
        seriesId: ids.series,
        q: " borrow ",
        targetFrom: "2026-10-01T00:00:00.000Z",
        targetTo: "2026-10-31T00:00:00.000Z",
        limit: "20",
      }),
    ).toEqual({
      states: ["idea", "review"],
      seriesId: ids.series,
      q: "borrow",
      targetFrom: "2026-10-01T00:00:00.000Z",
      targetTo: "2026-10-31T00:00:00.000Z",
      limit: 20,
    });
    expect(ListContentQuerySchema.parse({ states: ["approved"] })).toEqual({
      states: ["approved"],
    });
    expect(ListContentQuerySchema.safeParse({ states: "idea,drafting" }).success).toBe(false);
    expect(ListContentQuerySchema.safeParse({ states: "idea,idea" }).success).toBe(false);
    expect(
      ListContentQuerySchema.safeParse({
        targetFrom: "2026-10-31T00:00:00.000Z",
        targetTo: "2026-10-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("edits a version on top of a base version", () => {
    expect(EditVersionRequestSchema.safeParse({ baseVersionId: ids.version, script }).success).toBe(
      true,
    );
    expect(
      EditVersionRequestSchema.safeParse({ baseVersionId: ids.version, caption: null }).success,
    ).toBe(true);
    expect(EditVersionRequestSchema.safeParse({ baseVersionId: ids.version }).success).toBe(false);
    expect(EditVersionRequestSchema.safeParse({ script }).success).toBe(false);
    expect(
      EditVersionRequestSchema.safeParse({
        baseVersionId: ids.version,
        script: { ...script, segments: [] },
      }).success,
    ).toBe(false);
  });

  it("takes a produce target only for produce", () => {
    expect(ContentActionRequestSchema.safeParse({ action: "write_script" }).success).toBe(true);
    expect(
      ContentActionRequestSchema.safeParse({ action: "produce", through: "voice" }).success,
    ).toBe(true);
    expect(
      ContentActionRequestSchema.safeParse({ action: "voice", through: "review" }).success,
    ).toBe(false);
    expect(ContentActionRequestSchema.safeParse({ action: "publish" }).success).toBe(false);
  });

  it("returns an item with its current version, timeline and active job", () => {
    const detail = {
      item: contentItem,
      currentVersion: version,
      versions: [version].map(({ script: _s, storyboard: _b, caption: _c, ...summary }) => summary),
      activeJob: job,
    };

    expect(ContentItemDetailSchema.parse(detail)).toEqual(detail);
  });
});

describe("reviews", () => {
  const request = { versionId: ids.version, decision: "request_changes" };

  it("needs a comment to request changes", () => {
    expect(
      CreateReviewRequestSchema.safeParse({ ...request, comment: "Shorter hook" }).success,
    ).toBe(true);
    expect(CreateReviewRequestSchema.safeParse(request).success).toBe(false);
    expect(CreateReviewRequestSchema.safeParse({ ...request, comment: "   " }).success).toBe(false);
  });

  it("queues a revision only for a request for changes", () => {
    expect(
      CreateReviewRequestSchema.safeParse({
        ...request,
        comment: "Shorter hook",
        enqueueRevision: false,
      }).success,
    ).toBe(true);
    expect(CreateReviewRequestSchema.safeParse({ ...request, decision: "approve" }).success).toBe(
      true,
    );
    expect(
      CreateReviewRequestSchema.safeParse({
        ...request,
        decision: "approve",
        enqueueRevision: true,
      }).success,
    ).toBe(false);
  });
});

describe("assets", () => {
  const upload = {
    projectId: ids.project,
    itemId: ids.item,
    kind: "render",
    filename: "final.mp4",
    mime: "video/mp4",
    bytes: 12_345_678,
    sha256: "A".repeat(64),
  };

  it("accepts an upload and stores the checksum in lowercase", () => {
    expect(CreateUploadRequestSchema.parse(upload).sha256).toBe("a".repeat(64));
  });

  it("checks the MIME type against the kind", () => {
    expect(CreateUploadRequestSchema.safeParse({ ...upload, mime: "audio/mpeg" }).success).toBe(
      false,
    );
    expect(
      CreateUploadRequestSchema.safeParse({ ...upload, kind: "voice", mime: "audio/mpeg" }).success,
    ).toBe(true);
    expect(CreateUploadRequestSchema.safeParse({ ...upload, mime: "text/html" }).success).toBe(
      false,
    );
    for (const kind of ASSET_KINDS) {
      for (const mime of ASSET_KIND_MIME_TYPES[kind]) {
        expect(ASSET_MIME_TYPES).toContain(mime);
      }
    }
  });

  it("caps the size per kind", () => {
    expect(
      CreateUploadRequestSchema.safeParse({ ...upload, bytes: ASSET_KIND_MAX_BYTES.render })
        .success,
    ).toBe(true);
    expect(
      CreateUploadRequestSchema.safeParse({ ...upload, bytes: ASSET_KIND_MAX_BYTES.render + 1 })
        .success,
    ).toBe(false);
    expect(
      CreateUploadRequestSchema.safeParse({
        ...upload,
        kind: "poster",
        mime: "image/jpeg",
        bytes: ASSET_KIND_MAX_BYTES.poster + 1,
      }).success,
    ).toBe(false);
    expect(CreateUploadRequestSchema.safeParse({ ...upload, bytes: 0 }).success).toBe(false);
  });

  it("refuses file names with folders or control characters and bad digests", () => {
    for (const filename of ["../final.mp4", "a/b.mp4", "a\\b.mp4", "..", "a\u0000.mp4", ""]) {
      expect(AssetFilenameSchema.safeParse(filename).success, filename).toBe(false);
    }
    expect(CreateUploadRequestSchema.safeParse({ ...upload, sha256: "abc" }).success).toBe(false);
  });

  it("returns upload instructions, or none for a ready duplicate", () => {
    const instructions = {
      url: "https://media.example.test/projects/p/render/a.mp4",
      method: "PUT",
      headers: { "content-type": "video/mp4" },
      expiresAt: at,
    };

    expect(
      CreateUploadResponseSchema.safeParse({
        asset: { ...asset, status: "pending" },
        upload: instructions,
      }).success,
    ).toBe(true);
    expect(CreateUploadResponseSchema.safeParse({ asset, upload: null }).success).toBe(true);
    expect(
      CreateUploadResponseSchema.safeParse({ asset, upload: { ...instructions, method: "POST" } })
        .success,
    ).toBe(false);
  });

  it("carries a voice take's alignment in the detail", () => {
    expect(AssetDetailSchema.safeParse({ ...asset, kind: "voice", alignment }).success).toBe(true);
  });
});

describe("skill files", () => {
  const file = (path: string, content = "# Skill") => ({ path, content });

  it("accepts relative paths inside the skill", () => {
    for (const path of ["SKILL.md", "skill.json", "templates/hook.md", ".gitkeep", "a/b/c-d_e.f"]) {
      expect(isSkillPath(path), path).toBe(true);
    }
  });

  it("rejects traversal, absolute and irregular paths", () => {
    for (const path of [
      "../private",
      "a/../../b",
      "..",
      "a/..",
      "/etc/hosts",
      "a//b",
      "a/",
      "./a",
      "a/./b",
      ".",
      "a\\b",
      "a b.md",
      "~/x",
      "",
      "x".repeat(201),
    ]) {
      expect(isSkillPath(path), path).toBe(false);
      expect(SkillFilesSchema.safeParse([file(path)]).success, path).toBe(false);
    }
  });

  it("caps the number of files and the total size", () => {
    const files = Array.from({ length: SKILL_MAX_FILES + 1 }, (_, i) => file(`f${i}.md`));

    expect(SkillFilesSchema.safeParse(files.slice(1)).success).toBe(true);
    expect(SkillFilesSchema.safeParse(files).success).toBe(false);
    expect(SkillFilesSchema.safeParse([]).success).toBe(false);
    expect(SkillFilesSchema.safeParse([file("a.md", "x".repeat(SKILL_MAX_BYTES))]).success).toBe(
      true,
    );
    // Two bytes per character in UTF-8.
    expect(
      SkillFilesSchema.safeParse([file("a.md", "é".repeat(SKILL_MAX_BYTES / 2 + 1))]).success,
    ).toBe(false);
  });

  it("rejects paths that repeat, ignoring case, and binary content", () => {
    expect(SkillFilesSchema.safeParse([file("SKILL.md"), file("skill.md")]).success).toBe(false);
    expect(SkillFilesSchema.safeParse([file("a.bin", "\u0000\u0001")]).success).toBe(false);
  });

  it("reads the skill manifest", () => {
    const manifest = { name: "vertical-explainer", kind: "recipe", description: "Steps." };

    expect(SkillManifestSchema.parse(manifest)).toEqual(manifest);
    expect(SkillManifestSchema.safeParse({ ...manifest, name: "Vertical" }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...manifest, kind: "plugin" }).success).toBe(false);
  });

  it("builds the checksum input from files sorted by path", () => {
    const a = file("a.md", "A");
    const b = file("b/c.md", "BC");

    expect(skillChecksumInput([b, a])).toBe("a.md\u0000A\u0000b/c.md\u0000BC");
    expect(skillChecksumInput([a, b])).toBe(skillChecksumInput([b, a]));
  });
});

describe("pipeline routes", () => {
  const names = Object.keys(routes).filter((name) =>
    /^(formats|series|content|reviews|assets|skills)\./.test(name),
  );

  it("are all session routes under /api", () => {
    expect(names.length).toBeGreaterThan(30);
    for (const name of names) {
      const route = routes[name as keyof typeof routes];
      expect(route.auth, name).toBe("session");
      expect(route.path.startsWith("/api/"), name).toBe(true);
    }
  });

  it("never reuse a method and path", () => {
    const keys = Object.values(routes).map((route) => `${route.method} ${route.path}`);

    expect(new Set(keys).size).toBe(keys.length);
  });
});
