import { LayoutGridIcon } from "lucide-react";
import type { ProjectTab } from "../registry";

export const tab: ProjectTab = {
  id: "overview",
  label: "Overview",
  icon: LayoutGridIcon,
  to: "/projects/$projectId",
  order: 0,
};
