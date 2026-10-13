import { ClapperboardIcon } from "lucide-react";
import type { ProjectTab } from "../registry";

export const tab: ProjectTab = {
  id: "content",
  label: "Content",
  icon: ClapperboardIcon,
  to: "/projects/$projectId/content",
  order: 3,
};
