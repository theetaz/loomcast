import { ServerIcon } from "lucide-react";
import type { SettingsNavItem } from "../registry";

/** Only the owner manages API clients: every `/api/api-clients` route is owner-only. */
export const item: SettingsNavItem = {
  id: "api-clients",
  label: "API clients",
  description: "Backends that schedule posts through the API",
  icon: ServerIcon,
  to: "/settings/api-clients",
  order: 25,
  keywords: ["api", "rest", "key", "backend", "integration"],
  visible: (me) => me.role === "owner",
};
