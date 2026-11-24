import { createFileRoute } from "@tanstack/react-router";
import { handleLogin } from "../../server/auth/handlers.ts";
import { authRouteContext } from "../../server/auth/runtime.ts";

/** Starts the `deployments-web` authorization-code flow; `returnTo` is reduced to a console path. */
export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: ({ request }) => handleLogin(request, authRouteContext()),
    },
  },
});
