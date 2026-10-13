import { KeyRoundIcon } from "lucide-react";
import type { SettingsNavItem } from "../registry";

export const item: SettingsNavItem = {
  id: "tokens",
  label: "Access tokens",
  description: "Tokens for MCP clients",
  icon: KeyRoundIcon,
  to: "/settings/tokens",
  order: 20,
  keywords: ["mcp", "api", "token", "key"],
};
