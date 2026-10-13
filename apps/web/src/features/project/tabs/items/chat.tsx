import { MessagesSquareIcon } from "lucide-react";
import type { ProjectTab } from "../registry";

export const tab: ProjectTab = {
  id: "chat",
  label: "Chat",
  icon: MessagesSquareIcon,
  to: "/projects/$projectId/chat",
  order: 10,
};
