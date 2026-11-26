import { WrenchIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "workspace-skills",
  label: "Skills & tools",
  icon: WrenchIcon,
  to: "/w/$workspace/skills",
  order: 40,
  section: "studio",
};
