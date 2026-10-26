import { MessagesSquareIcon } from "lucide-react";
import type { NavItem } from "../registry";

export const item: NavItem = {
  id: "chat",
  label: "Chat",
  icon: MessagesSquareIcon,
  to: "/w/$workspace/chat",
  order: 0,
  section: "studio",
};
