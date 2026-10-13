import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@loomcast/ui/components/sidebar";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { type NavItem, type NavSection, navItems, navSection } from "./registry";

function NavLinkItem({ item, to }: { item: NavItem; to: NonNullable<NavItem["to"]> }) {
  const matchRoute = useMatchRoute();
  const { isMobile, setOpenMobile } = useSidebar();
  const isActive = Boolean(matchRoute({ to, fuzzy: !item.exact }));
  const Icon = item.icon;
  const Badge = item.badge;

  return (
    <SidebarMenuItem data-nav-item={item.id}>
      <SidebarMenuButton asChild isActive={isActive}>
        <Link to={to} onClick={() => isMobile && setOpenMobile(false)}>
          <Icon aria-hidden="true" />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
      {Badge ? <Badge /> : null}
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

/** The sidebar items of one section, from the nav registry. */
export function NavMenu({
  section,
  items = navItems,
}: {
  section: NavSection;
  /** Defaults to the registry; tests pass their own. */
  items?: readonly NavItem[];
}) {
  return (
    <SidebarMenu>
      {navSection(items, section).map((item) =>
        item.to ? (
          <NavLinkItem key={item.id} item={item} to={item.to} />
        ) : (
          <SoonItem key={item.id} item={item} />
        ),
      )}
    </SidebarMenu>
  );
}
