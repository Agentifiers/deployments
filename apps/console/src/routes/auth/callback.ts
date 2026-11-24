import { createFileRoute } from "@tanstack/react-router";
import { handleCallback } from "../../server/auth/handlers.ts";
import { authRouteContext } from "../../server/auth/runtime.ts";

/** OAuth redirect URI registered for `deployments-web`: `<CONSOLE_PUBLIC_ORIGIN>/auth/callback`. */
export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: ({ request }) => handleCallback(request, authRouteContext()),
    },
  },
});
