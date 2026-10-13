import { Avatar, AvatarFallback } from "@loomcast/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loomcast/ui/components/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@loomcast/ui/components/sidebar";
import { THEME_PREFERENCES, type ThemePreference, useTheme } from "@loomcast/ui/lib/theme";
import {
  ChevronsUpDownIcon,
  LogOutIcon,
  type LucideIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import { useLogout, useMe } from "@/features/auth/queries";
import { initials } from "@/lib/format";

const THEME_OPTIONS: Record<ThemePreference, { label: string; icon: LucideIcon }> = {
  light: { label: "Light", icon: SunIcon },
  dark: { label: "Dark", icon: MoonIcon },
  system: { label: "System", icon: MonitorIcon },
};

function isThemePreference(value: string): value is ThemePreference {
  return (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** The signed-in user, with the theme switch and sign-out. Theme changes apply instantly. */
export function UserMenu() {
  const me = useMe();
  const { preference, setPreference } = useTheme();
  const logout = useLogout();
  const displayName = me.name.trim() || me.email;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="h-10 gap-2.5 px-1.5">
              <Avatar size="sm" className="size-6">
                <AvatarFallback className="bg-accent-soft text-[10px] text-primary">
                  {initials(displayName)}
                </AvatarFallback>
              </Avatar>
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate font-medium text-[12.5px] text-foreground">
                  {displayName}
                </span>
                <span className="truncate text-[11.5px] text-muted-foreground">{me.email}</span>
              </span>
              <ChevronsUpDownIcon aria-hidden="true" className="size-3.5!" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-52"
          >
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={preference}
              onValueChange={(value) => {
                if (isThemePreference(value)) setPreference(value);
              }}
            >
              {THEME_PREFERENCES.map((value) => {
                const { label, icon: Icon } = THEME_OPTIONS[value];
                return (
                  <DropdownMenuRadioItem key={value} value={value}>
                    <Icon aria-hidden="true" />
                    {label}
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={logout.isPending} onSelect={() => logout.mutate()}>
              <LogOutIcon aria-hidden="true" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
