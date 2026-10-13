import { FolderIcon } from "lucide-react";
import { ActiveProjectCount } from "../badges";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "projects",
  label: "Projects",
  icon: FolderIcon,
  to: "/projects",
  order: 10,
  badge: ActiveProjectCount,
};
