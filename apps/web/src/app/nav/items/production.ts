import { FactoryIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "production",
  label: "Production",
  icon: FactoryIcon,
  to: "/w/$workspace/production",
  order: 25,
};
