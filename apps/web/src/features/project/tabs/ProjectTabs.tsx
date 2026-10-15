import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { useLocation, useMatch, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { activeTabFor, projectTabs } from "./registry";

/**
 * The project's tabs above the open tab's page. Choosing a tab opens its route; the indicator
 * slides in 220ms (the ui tabs component), and keyboard changes jump without animating.
 */
export function ProjectTabs({
  projectParam,
  children,
}: {
  projectParam: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const projectPath = useMatch({
    from: "/_app/projects/$projectId",
    select: (match) => match.pathname,
  });
  const pathname = useLocation({ select: (location) => location.pathname });
  const active = activeTabFor(projectTabs, pathname, projectPath) ?? projectTabs[0];
  const value = active?.id ?? "";

  return (
    <Tabs
      value={value}
      onValueChange={(id) => {
        const tab = projectTabs.find((item) => item.id === id);
        if (tab) void navigate({ to: tab.to, params: { projectId: projectParam } });
      }}
      className="min-h-0 flex-1 gap-4"
    >
      <ScrollArea orientation="horizontal" className="max-w-full shrink-0">
        <TabsList aria-label="Project sections" className="justify-start">
          {projectTabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              <tab.icon aria-hidden="true" />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </ScrollArea>
      <TabsContent value={value} className="flex min-h-0 flex-col gap-5">
        {children}
      </TabsContent>
    </Tabs>
  );
}
