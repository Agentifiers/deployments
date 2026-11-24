import { createFileRoute } from "@tanstack/react-router";
import { handleLogout } from "../../server/auth/handlers.ts";
import { authRouteContext } from "../../server/auth/runtime.ts";

/** Same-origin form post that revokes the BFF session and clears its cookie. */
export const Route = createFileRoute("/auth/logout")({
  server: {
    handlers: {
      POST: ({ request }) => handleLogout(request, authRouteContext()),
    },
  },
});
