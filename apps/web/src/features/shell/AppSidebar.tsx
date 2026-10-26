import { LoomcastMark } from "@loomcast/ui/brand";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
} from "@loomcast/ui/components/sidebar";
import { ChannelsSection } from "@/app/nav/channels-section";
import { NavMenu } from "@/app/nav/NavMenu";
import { useShellWorkspace } from "@/features/workspace/current";
import { UserMenu } from "./UserMenu";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

/**
 * The 240px sidebar from the brand prototype, organised by workspace: the switcher, the open
 * workspace's pages, its studio tools and its channels, then the account. Outside a workspace
 * (Account settings, the guide) it keeps working in the remembered one. Below `md` it opens as a
 * sheet. Its items come from the nav registry (`src/app/nav/items`).
 */
export function AppSidebar() {
  const workspace = useShellWorkspace();

  return (
    <Sidebar>
      {/* One landmark for the whole sidebar, on desktop and in the mobile sheet. */}
      <nav aria-label="Workspace" className="flex min-h-0 flex-1 flex-col">
        <SidebarHeader>
          <WorkspaceSwitcher workspace={workspace} />
        </SidebarHeader>

        <SidebarContent>
          {workspace ? (
            <>
              <SidebarGroup>
                <NavMenu section="main" workspace={workspace} label="Pages" />
              </SidebarGroup>
              <SidebarGroup className="pt-3">
                <SidebarGroupLabel className="text-muted-foreground">Studio</SidebarGroupLabel>
                <NavMenu section="studio" workspace={workspace} label="Studio" />
              </SidebarGroup>
              <ChannelsSection key={workspace.id} workspace={workspace} />
            </>
          ) : null}
        </SidebarContent>

        <SidebarFooter className="gap-1">
          <NavMenu section="footer" workspace={workspace} />
          <UserMenu />
          <p className="flex items-center gap-1.5 px-2 pt-1 text-[11px] text-text-4">
            <LoomcastMark size={12} aria-hidden="true" />
            Loomcast
          </p>
        </SidebarFooter>
      </nav>
    </Sidebar>
  );
}
