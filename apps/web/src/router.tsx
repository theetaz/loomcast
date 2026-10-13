import type { QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { toast } from "sonner";
import { NotFound } from "@/components/NotFound";
import { RouteError } from "@/components/RouteError";
import { api } from "@/lib/api";
import type { LiveClient } from "@/lib/live";
import { queryKeys } from "@/lib/query-keys";
import { routeTree } from "./routeTree.gen";

export interface AppRouterOptions {
  queryClient: QueryClient;
  live: LiveClient;
  /** Memory history in tests; the browser history otherwise. */
  history?: RouterHistory;
}

export function createAppRouter({ queryClient, live, history }: AppRouterOptions) {
  const router = createRouter({
    routeTree,
    context: { queryClient, live },
    history,
    // Query owns caching; the router only decides when to load.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
    defaultErrorComponent: RouteError,
  });

  // A session route answered 401: the session expired or was revoked elsewhere.
  api.setUnauthorizedHandler(() => {
    const { location } = router.state;
    if (location.pathname === "/login") return;
    queryClient.removeQueries({ queryKey: queryKeys.me });
    toast("Your session ended", {
      id: "session-ended",
      description: "Sign in again to pick up where you left off.",
    });
    void router.navigate({ to: "/login", search: { next: location.href }, replace: true });
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
