import { SlidersHorizontalIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "workspace-settings",
  label: "Workspace settings",
  icon: SlidersHorizontalIcon,
  to: "/w/$workspace/settings",
  order: 0,
  section: "footer",
};
