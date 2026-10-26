import { ClipboardCheckIcon } from "lucide-react";
import { ReviewCount } from "../badges";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "review",
  label: "Review",
  icon: ClipboardCheckIcon,
  to: "/w/$workspace/review",
  order: 30,
  badge: ReviewCount,
};
