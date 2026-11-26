import {
  completeSteps,
  type FormatRecipeUsage,
  PROGRESS_STEPS,
  type ProgressNameUsage,
  type ProgressStep,
  type ProgressStepKey,
  progressStage,
  type SkillRegistryRef,
  type SkillUsage,
  type SkillUsageItem,
  type WorkspaceSkills,
} from "@loomcast/contracts";
import {
  contentItems,
  contentProgress,
  type Database,
  formats,
  formatVersions,
  skills,
  skillVersions,
  workspaces,
} from "@loomcast/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { skillDescription } from "./mappers";

/** The fields of a `content_progress` row the usage counts read. */
export interface ProgressUsageRow {
  itemId: string;
  steps: readonly ProgressStep[];
  reportedAt: Date;
}

/** Which name of a step to count: the skill that guided it or the tool that did it. */
export type UsageField = "skill" | "tool";

const STEP_ORDER = new Map<ProgressStepKey, number>(
  PROGRESS_STEPS.map((key, index) => [key, index]),
);

function inStepOrder(steps: Iterable<ProgressStepKey>): ProgressStepKey[] {
  return [...steps].sort((a, b) => (STEP_ORDER.get(a) ?? 0) - (STEP_ORDER.get(b) ?? 0));
}

/** When a step was last worked on: its finish, else its start, else the report it came in. */
function stepTime(step: ProgressStep, reportedAt: Date): number {
  const at = step.finishedAt ?? step.startedAt;
  return at === null ? reportedAt.getTime() : Date.parse(at);
}

/**
 * Every skill or tool name the rows' steps used: how many items used it, in which steps and when
 * last, most recently used first (then by name). Steps without the name are left out.
 */
export function aggregateUsage(
  rows: readonly ProgressUsageRow[],
  field: UsageField,
): ProgressNameUsage[] {
  const byName = new Map<
    string,
    { items: Set<string>; steps: Set<ProgressStepKey>; last: number }
  >();
  for (const row of rows) {
    for (const step of row.steps) {
      const name = step[field];
      if (name === null || name === undefined) continue;
      const entry = byName.get(name) ?? { items: new Set(), steps: new Set(), last: 0 };
      entry.items.add(row.itemId);
      entry.steps.add(step.key);
      entry.last = Math.max(entry.last, stepTime(step, row.reportedAt));
      byName.set(name, entry);
    }
  }
  return [...byName]
    .map(([name, entry]) => ({
      name,
      items: entry.items.size,
      steps: inStepOrder(entry.steps),
      lastUsedAt: new Date(entry.last).toISOString(),
    }))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.name.localeCompare(b.name));
}

/** The steps of one item that used `skill`, and when last; null when none did. */
export function itemSkillUse(
  row: ProgressUsageRow,
  skill: string,
): { steps: ProgressStepKey[]; lastUsedAt: string } | null {
  const used = row.steps.filter((step) => step.skill === skill);
  if (used.length === 0) return null;
  const last = Math.max(...used.map((step) => stepTime(step, row.reportedAt)));
  return {
    steps: inStepOrder(used.map((step) => step.key)),
    lastUsedAt: new Date(last).toISOString(),
  };
}

export interface SkillUsageService {
  /** The workspace's skill and tool usage and its formats' recipes. */
  workspace(workspaceId: string): Promise<WorkspaceSkills>;
  /** Every skill name used in any workspace's progress. */
  all(): Promise<SkillUsage[]>;
  /** The items in any workspace whose progress used `name`, most recently used first. */
  items(name: string): Promise<SkillUsageItem[]>;
}

export function createSkillUsageService(deps: { db: Database }): SkillUsageService {
  const { db } = deps;

  /** The registry entries of the names that are registered skills. */
  async function registryOf(names: readonly string[]): Promise<Map<string, SkillRegistryRef>> {
    const unique = [...new Set(names)];
    if (unique.length === 0) return new Map();
    const rows = await db
      .select({ skill: skills, current: skillVersions })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
      .where(inArray(skills.name, unique));
    return new Map(
      rows.map(({ skill, current }) => [
        skill.name,
        {
          kind: skill.kind,
          description: skillDescription(current.files),
          latestVersion: current.version,
        },
      ]),
    );
  }

  async function withRegistry(usage: ProgressNameUsage[]): Promise<SkillUsage[]> {
    const registry = await registryOf(usage.map((entry) => entry.name));
    return usage.map((entry) => ({ ...entry, registry: registry.get(entry.name) ?? null }));
  }

  async function recipesOf(workspaceId: string): Promise<FormatRecipeUsage[]> {
    const rows = await db
      .select({ id: formats.id, name: formats.name, rules: formatVersions.rules })
      .from(formats)
      .innerJoin(formatVersions, eq(formatVersions.id, formats.currentVersionId))
      .where(and(eq(formats.workspaceId, workspaceId), isNull(formats.archivedAt)))
      .orderBy(asc(formats.name), asc(formats.id));
    const named = rows.flatMap((row) =>
      row.rules.recipe === undefined ? [] : [{ ...row, recipe: row.rules.recipe }],
    );
    const registry = await registryOf(named.map((row) => row.recipe.name));
    return named.map((row) => ({
      formatId: row.id,
      formatName: row.name,
      name: row.recipe.name,
      version: row.recipe.version ?? null,
      registry: registry.get(row.recipe.name) ?? null,
    }));
  }

  const usageColumns = {
    itemId: contentProgress.itemId,
    steps: contentProgress.steps,
    reportedAt: contentProgress.reportedAt,
  };

  return {
    async workspace(workspaceId) {
      const rows = await db
        .select(usageColumns)
        .from(contentProgress)
        .where(eq(contentProgress.workspaceId, workspaceId));
      return {
        workspaceId,
        skills: await withRegistry(aggregateUsage(rows, "skill")),
        tools: aggregateUsage(rows, "tool"),
        recipes: await recipesOf(workspaceId),
      };
    },

    async all() {
      const rows = await db.select(usageColumns).from(contentProgress);
      return withRegistry(aggregateUsage(rows, "skill"));
    },

    async items(name) {
      const rows = await db
        .select({
          ...usageColumns,
          workspaceId: contentProgress.workspaceId,
          workspaceSlug: workspaces.slug,
          workspaceName: workspaces.name,
          title: contentItems.title,
          itemState: contentItems.state,
        })
        .from(contentProgress)
        .innerJoin(contentItems, eq(contentItems.id, contentProgress.itemId))
        .innerJoin(workspaces, eq(workspaces.id, contentProgress.workspaceId))
        .where(sql`${contentProgress.steps} @> ${JSON.stringify([{ skill: name }])}::jsonb`);
      const items: SkillUsageItem[] = [];
      for (const row of rows) {
        const use = itemSkillUse(row, name);
        if (use === null) continue;
        const { stage, health } = progressStage(completeSteps(row.steps));
        items.push({
          itemId: row.itemId,
          workspaceId: row.workspaceId,
          workspaceSlug: row.workspaceSlug,
          workspaceName: row.workspaceName,
          title: row.title,
          itemState: row.itemState,
          stage,
          health,
          ...use,
        });
      }
      return items.sort(
        (a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.itemId.localeCompare(b.itemId),
      );
    },
  };
}
