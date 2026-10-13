import { TimerResetIcon } from "lucide-react";
import type { SettingsNavItem } from "../registry";

/** Every user is the owner or an admin, the roles the scheduler routes allow. */
export const item: SettingsNavItem = {
  id: "scheduler",
  label: "Scheduler",
  description: "Scheduled tasks that failed, and retrying them",
  icon: TimerResetIcon,
  to: "/settings/scheduler",
  order: 50,
  keywords: ["tasks", "dead letter", "retry", "jobs", "publishing"],
};
