import { SettingsIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "settings",
  label: "Account settings",
  icon: SettingsIcon,
  to: "/settings",
  order: 20,
  section: "footer",
};
