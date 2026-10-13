import { SettingsIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "settings",
  label: "Settings",
  icon: SettingsIcon,
  to: "/settings",
  order: 0,
  section: "footer",
};
