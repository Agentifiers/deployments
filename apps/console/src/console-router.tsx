import { QueryClient } from "@tanstack/react-query";
import { createRouter, type AnyRoute } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { ConsoleError, NotFound } from "./components/console-states.tsx";
import { shouldRetryQuery } from "./data/query-retry.ts";
import { DEFAULT_STALE_MS } from "./data/refresh.ts";
import {
  DEFAULT_CONSOLE_EDITION,
  rememberRouterInstall,
  type ConsoleEdition,
  type ConsoleRouterContext,
} from "./edition.ts";

/**
 * The router settings console pages expect, over any route tree whose root takes
 * `ConsoleRouterContext`. A host app that mounts the console's route files passes its own tree
 * and edition.
 */
export function createConsoleRouter<RouteTree extends AnyRoute>({
  edition = DEFAULT_CONSOLE_EDITION,
  routeTree,
}: {
  readonly edition?: ConsoleEdition;
  readonly routeTree: RouteTree;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      // The SSR query integration dehydrates every query unless this filter says otherwise.
      dehydrate: { shouldDehydrateQuery: (query) => query.meta?.["dehydrate"] !== false },
      queries: {
        retry: shouldRetryQuery,
        staleTime: DEFAULT_STALE_MS,
      },
    },
  });
  rememberRouterInstall(edition.install);
  const context: ConsoleRouterContext = { edition, queryClient };
  const router = createRouter({
    context,
    defaultErrorComponent: ConsoleError,
    defaultNotFoundComponent: NotFound,
    defaultPreload: "intent",
    routeTree,
    scrollRestoration: true,
  });
  setupRouterSsrQueryIntegration({ queryClient, router });
  return router;
}
