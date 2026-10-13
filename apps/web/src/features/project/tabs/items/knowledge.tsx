import { LibraryIcon } from "lucide-react";
import type { ProjectTab } from "../registry";

export const tab: ProjectTab = {
  id: "knowledge",
  label: "Knowledge",
  icon: LibraryIcon,
  to: "/projects/$projectId/kb",
  order: 20,
};
