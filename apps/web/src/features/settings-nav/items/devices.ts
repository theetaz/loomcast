import { MonitorSmartphoneIcon } from "lucide-react";
import type { SettingsNavItem } from "../registry";

export const item: SettingsNavItem = {
  id: "devices",
  label: "Devices",
  description: "Pair and revoke studio agents",
  icon: MonitorSmartphoneIcon,
  to: "/settings/devices",
  order: 10,
  keywords: ["studio", "agent", "pair", "mac"],
};
