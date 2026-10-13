import { UsersIcon } from "lucide-react";
import type { SettingsNavItem } from "../registry";

/** Only the owner manages members: every `/api/users` route is owner-only. */
export const item: SettingsNavItem = {
  id: "members",
  label: "Members",
  description: "Invite people and manage their access",
  icon: UsersIcon,
  to: "/settings/members",
  order: 30,
  keywords: ["users", "people", "invite", "team"],
  visible: (me) => me.role === "owner",
};
