import { CalendarDaysIcon } from "lucide-react";
import type { NavItem } from "../registry";

// Planned: the calendar gives this item its `to` when it lands.
export const item: NavItem = {
  id: "calendar",
  label: "Calendar",
  icon: CalendarDaysIcon,
  order: 40,
};
