import {
  type ApiError,
  completeSteps,
  PROGRESS_STEPS,
  type ProgressNameUsage,
  type ProgressStepKey,
  progressStage,
  routes,
  type SkillRegistryRef,
  type SkillSummary,
  type SkillUsageItem,
  type SkillVersionDetail,
  type SkillVersionSummary,
  type WorkspaceSkills,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { MockDb, MockSkillUse } from "./db";
import { MOCK_SKILLS } from "./formats";

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");

const inStepOrder = (keys: Iterable<ProgressStepKey>) =>
  [...keys].sort((a, b) => PROGRESS_STEPS.indexOf(a) - PROGRESS_STEPS.indexOf(b));

/** The mock registry's versions of a skill, newest first: one per version up to the latest. */
export function mockSkillVersions(skill: SkillSummary): SkillVersionDetail[] {
  return Array.from({ length: skill.latestVersion }, (_, index) => {
    const version = skill.latestVersion - index;
    const files = [
      {
        path: "SKILL.md",
        content: `# ${skill.name}\n\n${skill.description ?? ""}\n\n## Steps\n\n- Version ${version} of the steps.`,
      },
      {
        path: "skill.json",
        content: JSON.stringify(
          { name: skill.name, kind: skill.kind, description: skill.description },
          null,
          2,
        ),
      },
    ];
    return {
      skillId: skill.id,
      name: skill.name,
      kind: skill.kind,
      version,
      checksum: skill.checksum,
      changelog: version === 1 ? "First version." : `Version ${version}.`,
      fileCount: files.length,
      bytes: files.reduce((total, file) => total + file.content.length, 0),
      publishedByUser: null,
      publishedAt: skill.updatedAt,
      files,
    };
  });
}

function registryOf(name: string): SkillRegistryRef | null {
  const skill = MOCK_SKILLS.find((entry) => entry.name === name);
  return skill
    ? { kind: skill.kind, description: skill.description, latestVersion: skill.latestVersion }
    : null;
}

function aggregate(uses: readonly MockSkillUse[], field: "skill" | "tool"): ProgressNameUsage[] {
  const byName = new Map<
    string,
    { items: Set<string>; steps: Set<ProgressStepKey>; last: string }
  >();
  for (const use of uses) {
    for (const step of use.steps) {
      const name = step[field];
      if (name === null) continue;
      const entry = byName.get(name) ?? { items: new Set(), steps: new Set(), last: "" };
      entry.items.add(use.itemId);
      entry.steps.add(step.key);
      if (use.reportedAt > entry.last) entry.last = use.reportedAt;
      byName.set(name, entry);
    }
  }
  return [...byName]
    .map(([name, entry]) => ({
      name,
      items: entry.items.size,
      steps: inStepOrder(entry.steps),
      lastUsedAt: entry.last,
    }))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.name.localeCompare(b.name));
}

/** The skill registry's versions and the usage routes, following `@loomcast/contracts`. */
export function createSkillHandlers(db: MockDb) {
  const uses = () => db.skillUses ?? [];
  const findSkill = (name: unknown) => MOCK_SKILLS.find((skill) => skill.name === String(name));

  return [
    http.get(path("skills.usageAll"), () => {
      if (!db.signedIn) return unauthorized();
      const items = aggregate(uses(), "skill").map((entry) => ({
        ...entry,
        registry: registryOf(entry.name),
      }));
      return HttpResponse.json({ items });
    }),

    http.get(path("skills.workspace"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const workspaceId = String(params.workspaceId);
      if (!db.workspaces.some((workspace) => workspace.id === workspaceId)) {
        return apiError(404, "not_found", "Workspace not found.");
      }
      const mine = uses().filter((use) => use.workspaceId === workspaceId);
      const body: WorkspaceSkills = {
        workspaceId,
        skills: aggregate(mine, "skill").map((entry) => ({
          ...entry,
          registry: registryOf(entry.name),
        })),
        tools: aggregate(mine, "tool"),
        recipes: [],
      };
      return HttpResponse.json(body);
    }),

    http.get(path("skills.usage"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const name = String(params.name);
      const items: SkillUsageItem[] = uses().flatMap((use) => {
        const steps = use.steps.filter((step) => step.skill === name);
        const workspace = db.workspaces.find((entry) => entry.id === use.workspaceId);
        if (steps.length === 0 || workspace === undefined) return [];
        const complete = completeSteps(
          use.steps.map((step) => ({
            ...step,
            status: "done" as const,
            startedAt: null,
            finishedAt: null,
            note: null,
            error: null,
          })),
        );
        return [
          {
            itemId: use.itemId,
            workspaceId: workspace.id,
            workspaceSlug: workspace.slug,
            workspaceName: workspace.name,
            title: use.title,
            itemState: "idea",
            ...progressStage(complete),
            steps: inStepOrder(steps.map((step) => step.key)),
            lastUsedAt: use.reportedAt,
          },
        ];
      });
      return HttpResponse.json({ items });
    }),

    http.get(path("skills.versions"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const skill = findSkill(params.name);
      if (!skill) return apiError(404, "not_found", "No skill has that name.");
      const items: SkillVersionSummary[] = mockSkillVersions(skill).map(
        ({ files: _files, ...summary }) => summary,
      );
      return HttpResponse.json({ items });
    }),

    http.get(path("skills.get"), ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const skill = findSkill(params.name);
      if (!skill) return apiError(404, "not_found", "No skill has that name.");
      const asked = new URL(request.url).searchParams.get("version");
      const versions = mockSkillVersions(skill);
      const found =
        asked === null ? versions[0] : versions.find((entry) => entry.version === Number(asked));
      if (!found) return apiError(404, "not_found", "The skill has no version with that number.");
      return HttpResponse.json(found);
    }),
  ];
}
