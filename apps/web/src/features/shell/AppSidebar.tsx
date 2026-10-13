import { LoomcastMark } from "@loomcast/ui/brand";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@loomcast/ui/components/sidebar";
import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  CalendarDaysIcon,
  FolderIcon,
  HouseIcon,
  LibraryBigIcon,
  type LucideIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { projectsQueryOptions } from "@/features/projects/queries";
import { UserMenu } from "./UserMenu";

type NavTarget = "/" | "/projects" | "/settings";

function NavItem({
  to,
  label,
  icon: Icon,
  exact = false,
  badge,
}: {
  to: NavTarget;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  badge?: ReactNode;
}) {
  const matchRoute = useMatchRoute();
  const { isMobile, setOpenMobile } = useSidebar();
  const isActive = Boolean(matchRoute({ to, fuzzy: !exact }));

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive}>
        <Link to={to} onClick={() => isMobile && setOpenMobile(false)}>
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
      {badge}
    </SidebarMenuItem>
  );
}

function SoonItem({ label, icon }: { label: string; icon: ReactNode }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton disabled className="disabled:opacity-60">
        {icon}
        <span>{label}</span>
      </SidebarMenuButton>
      <SidebarMenuBadge className="top-1 text-[10.5px] text-muted-foreground">
        Soon
      </SidebarMenuBadge>
    </SidebarMenuItem>
  );
}

// Platform colours mark the channels; they are not brand tokens.
const CHANNELS = [
  { label: "Instagram", color: "#e1306c" },
  { label: "Threads", color: "var(--foreground)" },
  { label: "YouTube Shorts", color: "#ff3b30" },
] as const;

function ProjectCount() {
  const { data } = useQuery(projectsQueryOptions());
  const active = data?.filter((project) => project.status === "active").length;
  if (!active) return null;
  return (
    <SidebarMenuBadge className="top-1">
      <span className="sr-only">, </span>
      {active}
      <span className="sr-only"> active</span>
    </SidebarMenuBadge>
  );
}

/** The 240px workspace sidebar from the brand prototype. Below `md` it opens as a sheet. */
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
            <SidebarMenu>
              <NavItem to="/" label="Home" icon={HouseIcon} exact />
              <NavItem to="/projects" label="Projects" icon={FolderIcon} badge={<ProjectCount />} />
              <SoonItem label="Library" icon={<LibraryBigIcon aria-hidden="true" />} />
              <SoonItem label="Calendar" icon={<CalendarDaysIcon aria-hidden="true" />} />
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup className="pt-3">
            <SidebarGroupLabel className="text-muted-foreground">
              Channels
              <span className="ml-auto font-normal normal-case tracking-normal">Soon</span>
            </SidebarGroupLabel>
            <SidebarMenu aria-label="Channels">
              {CHANNELS.map((channel) => (
                <SidebarMenuItem key={channel.label}>
                  <SidebarMenuButton disabled className="disabled:opacity-60">
                    <span
                      aria-hidden="true"
                      className="ml-1 mr-0.5 size-[7px] shrink-0 rounded-full"
                      style={{ background: channel.color }}
                    />
                    <span>{channel.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="gap-1">
          <SidebarMenu>
            <NavItem to="/settings" label="Settings" icon={SettingsIcon} />
          </SidebarMenu>
          <UserMenu />
        </SidebarFooter>
      </nav>
    </Sidebar>
  );
}
