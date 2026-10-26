import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useMe } from "@/features/auth/queries";
import { useWorkspaceParam } from "@/features/workspace/current";

const SECTIONS = [
  { id: "general", label: "General", to: "/w/$workspace/settings", suffix: "/settings" },
  {
    id: "channels",
    label: "Channels",
    to: "/w/$workspace/settings/channels",
    suffix: "/settings/channels",
  },
  {
    id: "api-clients",
    label: "API clients",
    to: "/w/$workspace/settings/api-clients",
    suffix: "/settings/api-clients",
    // Every `/api/api-clients` route is owner-only.
    ownerOnly: true,
  },
] as const;

/** General, Channels and API clients of the open workspace, above the open section. */
export function WorkspaceSettingsTabs({ children }: { children: ReactNode }) {
  const me = useMe();
  const workspace = useWorkspaceParam();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname.replace(/\/$/, "") });
  const sections = SECTIONS.filter((section) => !("ownerOnly" in section) || me.role === "owner");
  // A section hidden from this user still renders its page (which explains why), with no tab active.
  const active =
    SECTIONS.find((section) => section.id !== "general" && pathname.endsWith(section.suffix))?.id ??
    "general";

  return (
    <Tabs
      value={active}
      onValueChange={(id) => {
        const section = SECTIONS.find((entry) => entry.id === id);
        if (section) void navigate({ to: section.to, params: { workspace } });
      }}
      className="gap-4"
    >
      <ScrollArea orientation="horizontal" className="max-w-full shrink-0">
        <TabsList aria-label="Workspace settings sections" className="justify-start">
          {sections.map((section) => (
            <TabsTrigger key={section.id} value={section.id}>
              {section.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </ScrollArea>
      <TabsContent value={active}>{children}</TabsContent>
    </Tabs>
  );
}
