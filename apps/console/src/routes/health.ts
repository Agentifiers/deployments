import { createFileRoute } from "@tanstack/react-router";

/** Unauthenticated liveness probe used by the deploy `verify` step. */
export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: () => Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } }),
    },
  },
});
