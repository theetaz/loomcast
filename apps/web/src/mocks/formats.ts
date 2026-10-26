import {
  type ApiError,
  CreateFormatRequestSchema,
  DEFAULT_FORMAT_RULES,
  type Format,
  type FormatRules,
  type FormatVersion,
  routes,
  type Series,
  type SkillSummary,
  slugify,
  UpdateFormatRequestSchema,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { z } from "zod";
import { type MockDb, mockId } from "./db";

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string, details?: unknown) {
  return HttpResponse.json<ApiError>(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");
const formatNotFound = () => apiError(404, "not_found", "No format has that id.");

/** The API's `validation_failed`: one `{path, message}` per issue, never the rejected value. */
function invalid(error: z.ZodError) {
  return apiError(
    400,
    "validation_failed",
    "The request is not valid.",
    error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );
}

function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

// Builders ----------------------------------------------------------------------

/** Default rules with `change` applied; the frozen defaults are copied first. */
export function mockRules(change: (rules: FormatRules) => void = () => {}): FormatRules {
  const rules = structuredClone(DEFAULT_FORMAT_RULES) as FormatRules;
  change(rules);
  return rules;
}

/**
 * A format and its versions: one per entry of `history` (oldest first), the last one current.
 * Without `history` it has version 1 with the default rules.
 */
export function mockFormat(
  overrides: Partial<Omit<Format, "currentVersion">> & Pick<Format, "workspaceId" | "name">,
  history: FormatRules[] = [mockRules()],
  createdAt = new Date().toISOString(),
): { format: Format; versions: FormatVersion[] } {
  const id = overrides.id ?? mockId();
  const start = Date.parse(createdAt);
  const versions = history.map(
    (rules, index): FormatVersion => ({
      id: mockId(),
      formatId: id,
      versionNo: index + 1,
      rules,
      createdBy: null,
      createdAt: new Date(start + index * 3_600_000).toISOString(),
    }),
  );
  const current = versions.at(-1) as FormatVersion;
  return {
    format: {
      id,
      slug: slugify(overrides.name),
      createdAt,
      updatedAt: current.createdAt,
      archivedAt: null,
      ...overrides,
      currentVersion: current,
    },
    versions,
  };
}

/** Demo rules for the demo series, so mock mode shows different cadences and a version history. */
function demoHistory(name: string): FormatRules[] {
  const first = mockRules((rules) => {
    rules.topicPool = ["borrowing", "moves", "lifetimes"];
  });
  switch (name) {
    case "Ownership basics":
      return [
        first,
        mockRules((rules) => {
          rules.tone =
            "Calm and precise. One idea per video, shown with a single runnable example.";
          rules.hookStyle = "demo";
          rules.lengthSec = { min: 30, max: 50 };
          rules.voiceId = "demo-voice-ava";
          rules.voiceSpeed = 1.05;
          rules.topicPool = ["borrowing", "moves", "lifetimes", "Rc and Arc", "slices"];
          rules.avoid = ["unsafe code"];
          rules.cadence = {
            days: ["mon", "wed", "fri"],
            slots: ["09:00", "18:00"],
            tz: "Europe/London",
            leadTimeHours: 36,
          };
          rules.caption = {
            hashtags: ["rustlang", "programming"],
            cta: "Follow for one Rust idea a day.",
          };
          rules.recipe = { name: "vertical-explainer" };
        }),
      ];
    case "Error handling":
      return [
        mockRules((rules) => {
          rules.hookStyle = "contrarian";
          rules.voiceId = "demo-voice-noah";
          rules.topicPool = ["Result", "the ? operator", "anyhow", "thiserror", "panics"];
          rules.cadence = {
            days: ["tue", "thu"],
            slots: ["12:30"],
            tz: "America/New_York",
            leadTimeHours: 48,
          };
          rules.publishMode = "auto";
          rules.caption = { hashtags: ["rustlang"] };
        }),
      ];
    case "Agent patterns":
      return [
        mockRules((rules) => {
          rules.visualTemplate = {
            styleId: "kallaway",
            captions: { enabled: true, style: "line" },
          };
          rules.topicPool = ["hand-offs", "tool design", "evaluation"];
          rules.cadence = {
            days: ["mon", "thu"],
            slots: ["08:00"],
            tz: "Asia/Kolkata",
            leadTimeHours: 24,
          };
        }),
      ];
    default:
      return [mockRules()];
  }
}

/**
 * Gives every series a format: series built with `mockSeries` name a format id nobody created, so
 * one is made for each with the default rules, named after the series. Called before every format
 * or series request, so the item page's length target and the editor read the same format.
 */
export function ensureFormats(
  db: MockDb,
  history: (series: Series) => FormatRules[] = () => [mockRules()],
) {
  for (const series of db.series) {
    if (db.formats.some((format) => format.id === series.formatId)) continue;
    const { format, versions } = mockFormat(
      { id: series.formatId, workspaceId: series.workspaceId, name: series.name },
      history(series),
      series.createdAt,
    );
    db.formats.push(format);
    db.formatVersions.push(...versions);
  }
}

/** Mock mode: the demo series get formats with their own rules and a version history. */
export function seedFormatDemo(db: MockDb) {
  ensureFormats(db, (series) => demoHistory(series.name));
}

/** Recipe and step skills the format editor offers, as `skills.list` lists them. */
export const MOCK_SKILLS: SkillSummary[] = [
  {
    id: "7b1f0b2e-1c1d-4a6e-9a51-0d6c1f2a3b4c",
    name: "vertical-explainer",
    kind: "recipe",
    description:
      "A 30 to 60 second explainer: hook, one idea, one example, a recap and a call to action.",
    latestVersion: 3,
    checksum: "a".repeat(64),
    updatedAt: "2026-10-10T09:00:00.000Z",
  },
  {
    id: "7b1f0b2e-1c1d-4a6e-9a51-0d6c1f2a3b4d",
    name: "error-first",
    kind: "recipe",
    description: "Opens on a failing example, explains the cause, then shows the fix running.",
    latestVersion: 1,
    checksum: "b".repeat(64),
    updatedAt: "2026-10-11T09:00:00.000Z",
  },
  {
    id: "7b1f0b2e-1c1d-4a6e-9a51-0d6c1f2a3b4e",
    name: "scriptwriting",
    kind: "skill",
    description: "How to write a short, spoken script.",
    latestVersion: 2,
    checksum: "c".repeat(64),
    updatedAt: "2026-10-09T09:00:00.000Z",
  },
];

// Handlers --------------------------------------------------------------------------

/** Formats (versioned on every update) and the skills list, following `@loomcast/contracts`. */
export function createFormatHandlers(db: MockDb) {
  const findFormat = (id: string) => {
    ensureFormats(db);
    return db.formats.find((format) => format.id === id);
  };

  return [
    http.get(path("formats.list"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      ensureFormats(db);
      const workspaceId = String(params.workspaceId);
      if (!db.workspaces.some((workspace) => workspace.id === workspaceId)) {
        return apiError(404, "not_found", "No workspace has that id.");
      }
      const items = db.formats
        .filter((format) => format.workspaceId === workspaceId)
        .sort((a, b) => a.name.localeCompare(b.name));
      return HttpResponse.json({ items });
    }),

    http.post(path("formats.create"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const workspace = db.workspaces.find((entry) => entry.id === params.workspaceId);
      if (!workspace) return apiError(404, "not_found", "No workspace has that id.");
      if (workspace.status === "archived") {
        return apiError(409, "conflict", "The workspace is archived.");
      }
      const parsed = CreateFormatRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      ensureFormats(db);
      const taken = new Set(
        db.formats
          .filter((format) => format.workspaceId === workspace.id)
          .map((format) => format.slug),
      );
      let slug = parsed.data.slug ?? (slugify(parsed.data.name) || "format");
      if (parsed.data.slug && taken.has(slug)) {
        return apiError(409, "conflict", "Another format of this workspace has that slug.");
      }
      for (let n = 2; taken.has(slug); n += 1) slug = `${slugify(parsed.data.name)}-${n}`;
      const { format, versions } = mockFormat(
        { workspaceId: workspace.id, name: parsed.data.name, slug },
        [parsed.data.rules ?? mockRules()],
      );
      db.formats.push(format);
      db.formatVersions.push(...versions);
      return HttpResponse.json(format, { status: 201 });
    }),

    http.get(path("formats.versions"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const format = findFormat(String(params.id));
      if (!format) return formatNotFound();
      const items = db.formatVersions
        .filter((version) => version.formatId === format.id)
        .sort((a, b) => b.versionNo - a.versionNo);
      return HttpResponse.json({ items });
    }),

    http.get(path("formats.get"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const format = findFormat(String(params.id));
      return format ? HttpResponse.json(format) : formatNotFound();
    }),

    http.patch(path("formats.update"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const format = findFormat(String(params.id));
      if (!format) return formatNotFound();
      const parsed = UpdateFormatRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      const update = parsed.data;
      if (update.baseVersionId !== format.currentVersion.id) {
        return apiError(409, "conflict", "This format has a newer version.");
      }
      const version: FormatVersion = {
        id: mockId(),
        formatId: format.id,
        versionNo: format.currentVersion.versionNo + 1,
        rules: update.rules ?? structuredClone(format.currentVersion.rules),
        createdBy: db.user.id,
        createdAt: nextTimestamp(format.currentVersion.createdAt),
      };
      db.formatVersions.push(version);
      if (update.name !== undefined) format.name = update.name;
      format.currentVersion = version;
      format.updatedAt = version.createdAt;
      return HttpResponse.json(format);
    }),

    http.get(path("skills.list"), () => {
      if (!db.signedIn) return unauthorized();
      return HttpResponse.json({ items: MOCK_SKILLS });
    }),
  ];
}
