import { CalendarClockIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "approvals",
  label: "Approvals",
  icon: CalendarClockIcon,
  to: "/approvals",
  order: 35,
};
