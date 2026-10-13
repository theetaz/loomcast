import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RequestHandler } from "msw";
import { createLiveClient, type EventSourceFactory } from "@/lib/live";
import { createQueryClient } from "@/lib/query-client";
import type { MockDb } from "@/mocks/db";
import { createHandlers } from "@/mocks/handlers";
import { createAppRouter } from "@/router";
import { server } from "./server";

/**
 * Renders the whole app at `path` against the mock API backed by `db`.
 * `overrides` take precedence over the mock API for the same routes.
 */
export function renderApp(
  path: string,
  db: MockDb,
  overrides: RequestHandler[] = [],
  options: { createEventSource?: EventSourceFactory | null } = {},
) {
  server.use(...overrides, ...createHandlers(db));
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
  });
  // jsdom has no EventSource: without a fake, the live client reports `unsupported`.
  const live = createLiveClient({
    queryClient,
    createEventSource: options.createEventSource ?? null,
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ queryClient, live, history });
  const user = userEvent.setup();
  const view = render(<RouterProvider router={router} />);
  return { ...view, router, queryClient, user, history };
}

export function currentPath(router: ReturnType<typeof createAppRouter>): string {
  return router.state.location.href;
}
