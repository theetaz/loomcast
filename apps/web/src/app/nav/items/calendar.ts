import { CalendarDaysIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "calendar",
  label: "Calendar",
  icon: CalendarDaysIcon,
  to: "/w/$workspace/calendar",
  order: 10,
};
