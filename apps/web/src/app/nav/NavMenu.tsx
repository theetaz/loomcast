import type { Workspace } from "@loomcast/contracts";
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@loomcast/ui/components/sidebar";
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  isWorkspacePath,
  type NavItem,
  type NavPath,
  type NavSection,
  navItems,
  navSection,
  type WorkspaceNavPath,
} from "./registry";

function NavLinkItem({
  item,
  to,
  workspace,
}: {
  item: NavItem;
  to: NavPath;
  workspace: Pick<Workspace, "id" | "slug"> | null;
}) {
  const matchRoute = useMatchRoute();
  const { isMobile, setOpenMobile } = useSidebar();
  const fuzzy = !item.exact;
  const inWorkspace = isWorkspacePath(to) && workspace !== null;
  const isActive = Boolean(
    inWorkspace
      ? matchRoute({ to, params: { workspace: workspace.slug }, fuzzy })
      : matchRoute({ to: to as Exclude<NavPath, WorkspaceNavPath>, fuzzy }),
  );
  const Icon = item.icon;
  const Badge = item.badge;
  const close = () => isMobile && setOpenMobile(false);
  const content = (
    <>
      <Icon aria-hidden="true" />
      <span>{item.label}</span>
    </>
  );

  return (
    <SidebarMenuItem data-nav-item={item.id}>
      <SidebarMenuButton asChild isActive={isActive}>
        {inWorkspace ? (
          <Link to={to} params={{ workspace: workspace.slug }} onClick={close}>
            {content}
          </Link>
        ) : (
          <Link to={to as Exclude<NavPath, WorkspaceNavPath>} onClick={close}>
            {content}
          </Link>
        )}
      </SidebarMenuButton>
      {Badge && workspace ? <Badge workspaceId={workspace.id} /> : null}
    </SidebarMenuItem>
  );
}

/** A planned screen: shown so the shape of the product is visible, but not reachable yet. */
function SoonItem({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <SidebarMenuItem data-nav-item={item.id}>
      <SidebarMenuButton disabled className="disabled:opacity-60">
        <Icon aria-hidden="true" />
        <span>{item.label}</span>
      </SidebarMenuButton>
      <SidebarMenuBadge className="top-1 text-[10.5px] text-muted-foreground">
        Soon
      </SidebarMenuBadge>
    </SidebarMenuItem>
  );
}

/**
 * The sidebar items of one section, from the nav registry. Items inside a workspace open in
 * `workspace`; without one they are left out.
 */
export function NavMenu({
  section,
  workspace = null,
  items = navItems,
  label,
}: {
  section: NavSection;
  workspace?: Pick<Workspace, "id" | "slug"> | null;
  /** Defaults to the registry; tests pass their own. */
  items?: readonly NavItem[];
  label?: string;
}) {
  const shown = navSection(items, section).filter(
    (item) => !item.to || !isWorkspacePath(item.to) || workspace !== null,
  );
  if (shown.length === 0) return null;
  return (
    <SidebarMenu aria-label={label}>
      {shown.map((item) =>
        item.to ? (
          <NavLinkItem key={item.id} item={item} to={item.to} workspace={workspace} />
        ) : (
          <SoonItem key={item.id} item={item} />
        ),
      )}
    </SidebarMenu>
  );
}
