import { LayoutDashboardIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "overview",
  label: "Overview",
  icon: LayoutDashboardIcon,
  to: "/w/$workspace",
  exact: true,
  order: 0,
};
