import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { agentListQuery } from "../../data/agent-queries.ts";
import { DEFAULT_CONSOLE_EDITION, type ConsoleRouterContext } from "../../edition.ts";
import type { ClientView } from "@/components/ui/render-client";
import type { AgentList } from "../../server/agent-data.ts";
import { renderWith } from "../apps/app-fixtures.tsx";
import { FirstAgent } from "./first-agent.tsx";

const scope = {
  environmentId: "01K000000000000000000000E1",
  organizationId: "01K000000000000000000000G1",
  projectId: "01K000000000000000000000J1",
};

async function render(
  list: Partial<AgentList>,
  ui: ReactNode,
  run: (view: ClientView) => Promise<void>,
) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(agentListQuery(scope, false).queryKey, {
    hiddenArchived: 0,
    releases: [],
    rows: [],
    ...list,
  } as AgentList);
  const router = createRouter({
    context: { edition: DEFAULT_CONSOLE_EDITION, queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRouteWithContext<ConsoleRouterContext>()({ component: () => ui }),
  });
  await router.load();
  await renderWith(queryClient, <RouterProvider router={router} />, run);
}

describe("FirstAgent", () => {
  test("a brand-new environment offers to create its first agent on the Agents page", async () => {
    await render({}, <FirstAgent scope={scope} />, async (view) => {
      expect(view.document.body.textContent).toContain("Create your first agent");
      const link = [...view.document.querySelectorAll("a")].find(
        (node) => node.textContent === "Create an agent",
      );
      expect(link?.getAttribute("href")).toBe(
        "/o/01K000000000000000000000G1/p/01K000000000000000000000J1/e/01K000000000000000000000E1/agents",
      );
    });
  });

  test("an environment that has or had agents shows nothing", async () => {
    for (const list of [
      { rows: [{}] as unknown as AgentList["rows"] },
      { hiddenArchived: 1 },
    ] satisfies Partial<AgentList>[]) {
      await render(list, <FirstAgent scope={scope} />, async (view) => {
        expect(view.document.body.textContent).toBe("");
      });
    }
  });
});
