import { ClipboardCheckIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "review",
  label: "Review",
  icon: ClipboardCheckIcon,
  to: "/review",
  order: 30,
};
