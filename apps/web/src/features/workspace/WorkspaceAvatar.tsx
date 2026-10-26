import type { Workspace } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";
import { useState } from "react";
import { initials } from "@/lib/format";
import { WORKSPACE_COLOR_META } from "./colors";

/**
 * The workspace's icon, or its initial on its colour while there is none or the image fails. The
 * icon comes through the API: the content security policy allows no image hosts. Decorative: the
 * name always sits beside it.
 */
export function WorkspaceAvatar({
  workspace,
  className,
}: {
  workspace: Pick<Workspace, "name" | "color" | "iconUrl">;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const icon = workspace.iconUrl && failed !== workspace.iconUrl ? workspace.iconUrl : null;
  const tone = WORKSPACE_COLOR_META[workspace.color] ?? WORKSPACE_COLOR_META.thread;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[18px] shrink-0 select-none items-center justify-center overflow-hidden rounded-[5px] font-semibold text-[10px]",
        icon ? "bg-secondary" : tone.soft,
        className,
      )}
    >
      {icon ? (
        <img src={icon} alt="" className="size-full object-cover" onError={() => setFailed(icon)} />
      ) : (
        initials(workspace.name).slice(0, 1)
      )}
    </span>
  );
}
