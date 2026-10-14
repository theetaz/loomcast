import { TelescopeIcon } from "lucide-react";
import type { ProjectTab } from "../registry";

export const tab: ProjectTab = {
  id: "competitors",
  label: "Competitors",
  icon: TelescopeIcon,
  to: "/projects/$projectId/competitors",
  order: 25,
};
