import { RadioTowerIcon } from "lucide-react";
import type { SettingsNavItem } from "../registry";

export const item: SettingsNavItem = {
  id: "channels",
  label: "Channels",
  description: "Accounts series publish to, dry-run and approval",
  icon: RadioTowerIcon,
  to: "/settings/channels",
  order: 40,
  keywords: ["facebook", "instagram", "threads", "publish", "dry run", "approval"],
};
