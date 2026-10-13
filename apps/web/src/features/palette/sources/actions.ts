import { useTheme } from "@loomcast/ui/lib/theme";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LightbulbIcon, MoonIcon, PlusIcon, SunIcon, ZapIcon } from "lucide-react";
import { projectsQueryOptions } from "@/features/projects/queries";
import { rankByMatch } from "../match";
import type { PaletteItem, PaletteSource } from "../types";

type Action = PaletteItem & { keywords: readonly string[] };

/** Things to do rather than places to go. Actions are never added to Recent. */
export const source: PaletteSource = {
  id: "actions",
  heading: "Actions",
  order: 30,
  icon: ZapIcon,
  useItems: ({ query, projectParam, openNewProject }) => {
    const navigate = useNavigate();
    const { data: projects = [] } = useQuery(projectsQueryOptions());
    const { resolvedTheme, setPreference } = useTheme();

    const actions: Action[] = [
      {
        id: "action:new-project",
        label: "New project",
        icon: PlusIcon,
        keywords: ["create", "add", "project"],
        run: openNewProject,
      },
    ];

    if (projectParam) {
      const project = projects.find(
        (item) => item.id === projectParam || item.slug === projectParam,
      );
      actions.push({
        id: "action:new-brainstorm",
        label: project ? `New brainstorm in ${project.name}` : "New brainstorm in this project",
        icon: LightbulbIcon,
        keywords: ["create", "add", "idea", "kb", "knowledge", "note"],
        run: () =>
          void navigate({
            to: "/projects/$projectId/kb/new",
            params: { projectId: projectParam },
            search: { kind: "brainstorm" },
          }),
      });
    }

    const dark = resolvedTheme === "dark";
    actions.push({
      id: "action:toggle-theme",
      label: dark ? "Switch to light theme" : "Switch to dark theme",
      icon: dark ? SunIcon : MoonIcon,
      keywords: ["theme", "appearance", "mode", "dark", "light", "toggle"],
      run: () => setPreference(dark ? "light" : "dark"),
    });

    return rankByMatch(actions, query, (action) => ({
      label: action.label,
      keywords: action.keywords,
    }));
  },
};
