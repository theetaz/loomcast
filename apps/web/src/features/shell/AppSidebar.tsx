import { LoomcastMark } from "@loomcast/ui/brand";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  useSidebar,
} from "@loomcast/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { ChannelsSection } from "@/app/nav/channels-section";
import { NavMenu } from "@/app/nav/NavMenu";
import { UserMenu } from "./UserMenu";

/**
 * The 240px workspace sidebar from the brand prototype. Below `md` it opens as a sheet. Its items
 * come from the nav registry (`src/app/nav/items`).
 */
export function AppSidebar() {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <Sidebar>
      {/* One landmark for the whole sidebar, on desktop and in the mobile sheet. */}
      <nav aria-label="Workspace" className="flex min-h-0 flex-1 flex-col">
        <SidebarHeader>
          <Link
            to="/"
            onClick={() => isMobile && setOpenMobile(false)}
            className="flex h-8 items-center gap-2 rounded-md px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LoomcastMark size={22} aria-hidden="true" />
            <span className="font-semibold text-[13.5px] text-foreground tracking-[-0.01em]">
              Loomcast
            </span>
          </Link>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <NavMenu section="main" />
          </SidebarGroup>
          <ChannelsSection />
        </SidebarContent>

        <SidebarFooter className="gap-1">
          <NavMenu section="footer" />
          <UserMenu />
        </SidebarFooter>
      </nav>
    </Sidebar>
  );
}
