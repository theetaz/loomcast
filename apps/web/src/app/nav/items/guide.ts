import { BookOpenIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "guide",
  label: "Guide",
  icon: BookOpenIcon,
  to: "/guide",
  order: 10,
  section: "footer",
};
