import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { createFileRoute, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { Page, PageHeader } from "@/components/PageHeader";

const SETTINGS_TABS = [
  { to: "/settings/devices", label: "Devices" },
  { to: "/settings/tokens", label: "Access tokens" },
] as const;

type SettingsPath = (typeof SETTINGS_TABS)[number]["to"];

function isSettingsPath(value: string): value is SettingsPath {
  return SETTINGS_TABS.some((tab) => tab.to === value);
}

export const Route = createFileRoute("/_app/settings")({
  staticData: { breadcrumb: "Settings" },
  component: SettingsLayout,
});

function SettingsLayout() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname.replace(/\/$/, "") });
  const active = isSettingsPath(pathname) ? pathname : SETTINGS_TABS[0].to;

  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Studio agents that render for this workspace, and tokens for connecting other tools."
      />
      <Tabs
        value={active}
        onValueChange={(value) => {
          if (isSettingsPath(value)) void navigate({ to: value });
        }}
        className="gap-4"
      >
        <TabsList aria-label="Settings sections">
          {SETTINGS_TABS.map((tab) => (
            <TabsTrigger key={tab.to} value={tab.to}>
              {tab.label}
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
