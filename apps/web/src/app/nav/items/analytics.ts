import { ChartColumnBigIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "analytics",
  label: "Analytics",
  icon: ChartColumnBigIcon,
  to: "/w/$workspace/analytics",
  order: 50,
};
