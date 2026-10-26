import { LibraryIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "knowledge",
  label: "Knowledge",
  icon: LibraryIcon,
  to: "/w/$workspace/kb",
  order: 10,
  section: "studio",
};
