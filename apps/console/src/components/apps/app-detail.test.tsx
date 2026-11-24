import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { OperationAccess } from "../../access.ts";
import { AppDetail } from "./app-detail.tsx";
import { accessOf, app, APP, client, renderWith, scope, unverified } from "./app-fixtures.tsx";

async function page(access: OperationAccess) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <AppDetail access={access} appId={APP} scope={scope} />,
    }),
  });
  await router.load();
  return <RouterProvider router={router} />;
}

test("the app page mounts Publication, and Domains only for a reader of the domain list", async () => {
  const seen: Record<string, unknown> = {};
  for (const [label, access] of [
    ["admin", accessOf("admin")],
    ["member", accessOf("member")],
    ["member without listAppDomains", { ...accessOf("member"), listAppDomains: false }],
  ] as const) {
    await renderWith(
      client({ app: app({ audience: "public", serving: "static-site" }), domains: [unverified] }),
      await page({
        ...access,
        listAgentDefinitions: false,
        listAppGrants: false,
        listAppReleases: false,
      }),
      async (view) => {
        seen[label] = {
          headings: [...view.document.querySelectorAll("h2, h3")].map((node) => node.textContent),
          hostnames: [...view.document.querySelectorAll("tbody tr td:first-child")].map(
            (cell) => cell.textContent,
          ),
        };
      },
    );
  }
  expect(seen).toEqual({
    admin: { headings: ["Sign-up form", "Publication", "Domains"], hostnames: ["www.example.com"] },
    member: {
      headings: ["Sign-up form", "Publication", "Domains"],
      hostnames: ["www.example.com"],
    },
    "member without listAppDomains": { headings: ["Sign-up form", "Publication"], hostnames: [] },
  });
});
