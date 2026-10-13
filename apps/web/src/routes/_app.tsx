import { SidebarInset, SidebarProvider } from "@loomcast/ui/components/sidebar";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { meQueryOptions } from "@/features/auth/queries";
import { AppSidebar } from "@/features/shell/AppSidebar";
import { Topbar } from "@/features/shell/Topbar";
import { isApiError } from "@/lib/api";
import { useLiveEvents } from "@/lib/live";

/** Every signed-in screen. The guard loads the user once and reuses the cache after that. */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    try {
      const me = await context.queryClient.ensureQueryData(meQueryOptions());
      return { me };
    } catch (error) {
      if (isApiError(error, 401)) {
        throw redirect({ to: "/login", search: { next: location.href }, replace: true });
      }
      throw error;
    }
  },
  component: AppLayout,
});

const sidebarStyle = { "--sidebar-width": "240px" } as CSSProperties;

function AppLayout() {
  useLiveEvents();

  return (
    <SidebarProvider style={sidebarStyle}>
      <a
        href="#content"
        className="sr-only z-50 rounded-md bg-card px-3 py-2 text-control shadow-pop focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <Topbar />
        <div id="content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
