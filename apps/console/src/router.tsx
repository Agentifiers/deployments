import { createConsoleRouter } from "./console-router.tsx";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  return createConsoleRouter({ routeTree });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
