import { ListVideoIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "series",
  label: "Series",
  icon: ListVideoIcon,
  to: "/w/$workspace/series",
  order: 20,
  section: "studio",
};
