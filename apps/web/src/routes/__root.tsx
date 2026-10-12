import { Toaster } from "@loomcast/ui/components/sonner";
import { TooltipProvider } from "@loomcast/ui/components/tooltip";
import { useTheme } from "@loomcast/ui/lib/theme";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { NotFound } from "@/components/NotFound";
import { RouteError } from "@/components/RouteError";
import { type LiveClient, LiveProvider } from "@/lib/live";

export interface RouterContext {
  queryClient: QueryClient;
  live: LiveClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

/** Subscribing keeps the theme in step with the OS and other tabs on every screen. */
function ThemeSync() {
  useTheme();
  return null;
}

function Root() {
  const { queryClient, live } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <LiveProvider client={live}>
        <TooltipProvider>
          <ThemeSync />
          <Outlet />
          <Toaster />
        </TooltipProvider>
      </LiveProvider>
    </QueryClientProvider>
  );
}
