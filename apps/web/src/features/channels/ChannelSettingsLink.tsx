import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { useOptionalWorkspaceParam } from "@/features/workspace/current";

/**
 * A link to the open workspace's channel settings, for "connect a channel first" hints. Outside a
 * workspace it opens the workspace list. Passes its props through, so it works under `asChild`.
 */
export function ChannelSettingsLink(props: Omit<ComponentProps<"a">, "href" | "ref">) {
  const workspace = useOptionalWorkspaceParam();
  return workspace ? (
    <Link {...props} to="/w/$workspace/settings/channels" params={{ workspace }} />
  ) : (
    <Link {...props} to="/workspaces" />
  );
}
