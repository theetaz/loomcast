import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@loomcast/ui/components/sidebar";

// Platform colours mark the channels; they are not brand tokens.
export const PLANNED_CHANNELS = [
  { label: "Facebook", color: "#1877f2" },
  { label: "Instagram", color: "#e1306c" },
  { label: "Threads", color: "var(--foreground)" },
  { label: "X", color: "var(--color-text-2)" },
] as const;

/**
 * The platforms Loomcast publishes to. Until channels can be connected they are listed as coming
 * soon; the channels work replaces this with the connected channels and their status.
 */
export function ChannelsSection() {
  return (
    <SidebarGroup className="pt-3">
      <SidebarGroupLabel className="text-muted-foreground">
        Channels
        <span className="ml-auto font-normal normal-case tracking-normal">Soon</span>
      </SidebarGroupLabel>
      <SidebarMenu aria-label="Channels">
        {PLANNED_CHANNELS.map((channel) => (
          <SidebarMenuItem key={channel.label}>
            <SidebarMenuButton disabled className="disabled:opacity-60">
              <span
                aria-hidden="true"
                className="mr-0.5 ml-1 size-[7px] shrink-0 rounded-full"
                style={{ background: channel.color }}
              />
              <span>{channel.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
