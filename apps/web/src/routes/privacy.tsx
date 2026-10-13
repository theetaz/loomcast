import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPage } from "@/features/legal/PrivacyPage";

/** Public: linked from the login page and from the Meta app settings, never behind the guard. */
export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
});
