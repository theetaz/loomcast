import {
  type List,
  SKILL_NAME_RE,
  type SkillFile,
  type SkillSummary,
  type SkillUsage,
  type SkillUsageItem,
  type SkillVersionSummary,
} from "@loomcast/contracts";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "@/lib/api";
import { useLiveEvent } from "@/lib/live";

/**
 * Skills catalogue query keys. `["skills", "list"]` is shared with the format editor's recipe
 * picker, so both read one cache.
 */
export const skillKeys = {
  all: ["skills"] as const,
  list: ["skills", "list"] as const,
  usageAll: ["skills", "usage"] as const,
  usage: (name: string) => ["skills", "usage", name] as const,
  detail: (name: string, version: number | undefined) =>
    ["skills", "detail", name, version ?? "latest"] as const,
  versions: (name: string) => ["skills", "versions", name] as const,
  workspace: (workspaceId: string) => ["skills", "workspace", workspaceId] as const,
};

/** Whether a name reported in progress can be a registry skill, and so has a catalogue page. */
export function isSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

export function skillsListQueryOptions() {
  return queryOptions({
    queryKey: skillKeys.list,
    queryFn: ({ signal }) => api.request("skills.list", { signal }),
    select: (list: List<SkillSummary>) => list.items,
  });
}

export function skillUsageAllQueryOptions() {
  return queryOptions({
    queryKey: skillKeys.usageAll,
    queryFn: ({ signal }) => api.request("skills.usageAll", { signal }),
    select: (list: List<SkillUsage>) => list.items,
  });
}

/** One version with its files; null when the skill is not in the registry (404). */
export function skillDetailQueryOptions(name: string, version?: number) {
  return queryOptions({
    queryKey: skillKeys.detail(name, version),
    queryFn: async ({ signal }) => {
      try {
        return await api.request("skills.get", {
          params: { name },
          query: version === undefined ? {} : { version },
          signal,
        });
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
  });
}

export function skillVersionsQueryOptions(name: string) {
  return queryOptions({
    queryKey: skillKeys.versions(name),
    queryFn: async ({ signal }) => {
      try {
        return (await api.request("skills.versions", { params: { name }, signal })).items;
      } catch (error) {
        if (isApiError(error) && error.status === 404) return [] as SkillVersionSummary[];
        throw error;
      }
    },
  });
}

export function skillUsageQueryOptions(name: string) {
  return queryOptions({
    queryKey: skillKeys.usage(name),
    queryFn: ({ signal }) => api.request("skills.usage", { params: { name }, signal }),
    select: (list: List<SkillUsageItem>) => list.items,
  });
}

export function workspaceSkillsQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: skillKeys.workspace(workspaceId),
    queryFn: ({ signal }) => api.request("skills.workspace", { params: { workspaceId }, signal }),
  });
}

/** A catalogue row: a registry skill with how many items used it. */
export interface CatalogueRow {
  skill: SkillSummary;
  items: number;
  lastUsedAt: string | null;
}

/** Every registry skill with its usage, by name; and the used names the registry does not have. */
export function catalogueRows(
  skills: readonly SkillSummary[],
  usage: readonly SkillUsage[],
): { rows: CatalogueRow[]; unregistered: SkillUsage[] } {
  const byName = new Map(usage.map((entry) => [entry.name, entry]));
  const rows = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => {
      const used = byName.get(skill.name);
      return { skill, items: used?.items ?? 0, lastUsedAt: used?.lastUsedAt ?? null };
    });
  const registered = new Set(skills.map((skill) => skill.name));
  const unregistered = usage.filter((entry) => !registered.has(entry.name));
  return { rows, unregistered };
}

/** `SKILL.md` first, then `skill.json`, then the rest by path. */
export function sortSkillFiles(files: readonly SkillFile[]): SkillFile[] {
  const rank = (path: string) => (path === "SKILL.md" ? 0 : path === "skill.json" ? 1 : 2);
  return [...files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

/** Whether a skill file reads as markdown. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** A new version can change the catalogue, its usage and every open skill page. */
export function useSkillsLive() {
  const queryClient = useQueryClient();
  useLiveEvent("skill.published", () => {
    void queryClient.invalidateQueries({ queryKey: skillKeys.all });
  });
  useLiveEvent("content.progress.updated", () => {
    void queryClient.invalidateQueries({ queryKey: skillKeys.usageAll });
    void queryClient.invalidateQueries({ queryKey: ["skills", "workspace"] });
  });
}
