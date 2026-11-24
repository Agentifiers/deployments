import { createFileRoute, redirect } from "@tanstack/react-router";

/** Releases have no index of their own; each definition page lists its releases. */
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/workflows/releases/")({
  beforeLoad: ({ params }) => {
    throw redirect({ params, replace: true, to: "/o/$orgId/p/$projectId/e/$envId/workflows" });
  },
});
