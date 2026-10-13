import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { createFileRoute, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { Page, PageHeader } from "@/components/PageHeader";
import { useMe } from "@/features/auth/queries";
import { type SettingsPath, visibleSettingsItems } from "@/features/settings-nav/registry";

export const Route = createFileRoute("/_app/settings")({
  staticData: { breadcrumb: "Settings" },
  component: SettingsLayout,
});

/** The sections come from the settings-nav registry, filtered to what the user may open. */
function SettingsLayout() {
  const me = useMe();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname.replace(/\/$/, "") });
  const items = visibleSettingsItems(me);
  const paths = new Set<string>(items.map((item) => item.to));
  const isSettingsPath = (value: string): value is SettingsPath => paths.has(value);
  // A section hidden from this user still renders its page (which explains why), with no tab active.
  const active = pathname;
  const ownsMembers = items.some((item) => item.id === "members");

  return (
    <Page>
      <PageHeader
        title="Settings"
        description={
          ownsMembers
            ? "Studio agents that render for this workspace, tokens for connecting other tools, and the people who can sign in."
            : "Studio agents that render for this workspace, and tokens for connecting other tools."
        }
      />
      <Tabs
        value={active}
        onValueChange={(value) => {
          if (isSettingsPath(value)) void navigate({ to: value });
        }}
        className="gap-4"
      >
        <TabsList aria-label="Settings sections">
          {items.map((item) => (
            <TabsTrigger key={item.id} value={item.to}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={active}>
          <Outlet />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
