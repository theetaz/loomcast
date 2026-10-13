import { createFileRoute } from "@tanstack/react-router";
import { DataDeletionPage } from "@/features/legal/DataDeletionPage";

/** Public: linked from the login page and from the Meta app settings, never behind the guard. */
export const Route = createFileRoute("/data-deletion")({
  component: DataDeletionPage,
});
