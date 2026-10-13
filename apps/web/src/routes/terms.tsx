import { createFileRoute } from "@tanstack/react-router";
import { TermsPage } from "@/features/legal/TermsPage";

/** Public: linked from the login page and from the Meta app settings, never behind the guard. */
export const Route = createFileRoute("/terms")({
  component: TermsPage,
});
