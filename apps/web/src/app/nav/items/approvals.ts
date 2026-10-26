import { CalendarClockIcon } from "lucide-react";
import { ApprovalsCount } from "../badges";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "approvals",
  label: "Approvals",
  icon: CalendarClockIcon,
  to: "/w/$workspace/approvals",
  order: 40,
  badge: ApprovalsCount,
};
