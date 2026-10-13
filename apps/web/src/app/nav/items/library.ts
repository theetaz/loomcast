import { LibraryBigIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "library",
  label: "Library",
  icon: LibraryBigIcon,
  to: "/library",
  order: 20,
};
