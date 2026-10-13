import { ListVideoIcon } from "lucide-react";
import type { ProjectTab } from "../registry";

export const tab: ProjectTab = {
  id: "series",
  label: "Series",
  icon: ListVideoIcon,
  to: "/projects/$projectId/series",
  order: 6,
};
