import type { Workspace } from "@loomcast/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loomcast/ui/components/dropdown-menu";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@loomcast/ui/components/sidebar";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, FolderIcon, LayoutGridIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { WorkspaceAvatar } from "@/features/workspace/WorkspaceAvatar";
import { NewWorkspaceDialog } from "@/features/workspaces/NewWorkspaceDialog";
import { workspacesQueryOptions } from "@/features/workspaces/queries";

/**
 * The sidebar header: the workspace the app works in, and a menu to switch to another active
 * workspace, see them all or create one. The menu opens like every other dropdown, keyboard
 * included; picking a workspace opens its overview.
 */
export function WorkspaceSwitcher({ workspace }: { workspace: Workspace | null }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const [creating, setCreating] = useState(false);
  const list = useQuery(workspacesQueryOptions());
  const active = (list.data ?? []).filter((entry) => entry.status === "active");
  const close = () => isMobile && setOpenMobile(false);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="h-10 gap-2.5 px-1.5"
              aria-label={
                workspace ? `Workspace: ${workspace.name}. Switch workspace` : "Choose a workspace"
              }
            >
              {workspace ? (
                <WorkspaceAvatar
                  workspace={workspace}
                  className="size-6 rounded-md text-[11.5px]"
                />
              ) : (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                  <FolderIcon aria-hidden="true" className="size-3.5" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate font-semibold text-[13.5px] text-foreground tracking-[-0.01em]">
                {workspace?.name ?? (list.isPending ? "" : "No workspace")}
              </span>
              <ChevronsUpDownIcon aria-hidden="true" className="size-3.5! text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-60"
          >
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            {active.length === 0 ? (
              <DropdownMenuItem disabled>
                {list.isPending ? "Loading workspaces…" : "No active workspaces"}
              </DropdownMenuItem>
            ) : (
              <ScrollArea viewportClassName="max-h-72">
                <DropdownMenuGroup aria-label="Active workspaces">
                  {active.map((entry) => {
                    const current = entry.id === workspace?.id;
                    return (
                      <DropdownMenuItem key={entry.id} asChild>
                        <Link to="/w/$workspace" params={{ workspace: entry.slug }} onClick={close}>
                          <WorkspaceAvatar workspace={entry} />
                          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                          {current ? (
                            <>
                              <CheckIcon aria-hidden="true" className="ml-auto text-primary" />
                              <span className="sr-only">, open</span>
                            </>
                          ) : null}
                        </Link>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              </ScrollArea>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/workspaces" onClick={close}>
                <LayoutGridIcon aria-hidden="true" />
                All workspaces
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setCreating(true)}>
              <PlusIcon aria-hidden="true" />
              New workspace…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <NewWorkspaceDialog
          open={creating}
          onOpenChange={(open) => {
            setCreating(open);
            if (!open) close();
          }}
        />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
