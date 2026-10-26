import { TelescopeIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "competitors",
  label: "Competitors",
  icon: TelescopeIcon,
  to: "/w/$workspace/competitors",
  order: 30,
  section: "studio",
};
