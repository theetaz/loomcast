import { createFileRoute } from "@tanstack/react-router";
import { SetPasswordPage } from "@/features/members/SetPasswordPage";

/**
 * Public: invitation and reset links (`/set-password#token=…`) land here,
 * outside the `_app` guard. The page clears the token from the URL at once.
 */
export const Route = createFileRoute("/set-password")({
  component: SetPasswordPage,
});
