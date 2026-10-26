import { useTheme } from "@loomcast/ui/lib/theme";
import { useNavigate } from "@tanstack/react-router";
import { LightbulbIcon, MoonIcon, PlusIcon, SunIcon, ZapIcon } from "lucide-react";
import { rankByMatch } from "../match";
import type { PaletteItem, PaletteSource } from "../types";

type Action = PaletteItem & { keywords: readonly string[] };

/** Things to do rather than places to go. Actions are never added to Recent. */
export const source: PaletteSource = {
  id: "actions",
  heading: "Actions",
  order: 30,
  icon: ZapIcon,
  useItems: ({ query, workspace, openNewWorkspace }) => {
    const navigate = useNavigate();
    const { resolvedTheme, setPreference } = useTheme();

    const actions: Action[] = [
      {
        id: "action:new-workspace",
        label: "New workspace",
        icon: PlusIcon,
        keywords: ["create", "add", "workspace"],
        run: openNewWorkspace,
      },
    ];

    if (workspace) {
      actions.push({
        id: "action:new-brainstorm",
        label: `New brainstorm in ${workspace.name}`,
        icon: LightbulbIcon,
        keywords: ["create", "add", "idea", "kb", "knowledge", "note"],
        run: () =>
          void navigate({
            to: "/w/$workspace/kb/new",
            params: { workspace: workspace.slug },
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
