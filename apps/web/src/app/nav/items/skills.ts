import { PuzzleIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "skills",
  label: "Skills",
  icon: PuzzleIcon,
  to: "/skills",
  order: 15,
  section: "footer",
};
