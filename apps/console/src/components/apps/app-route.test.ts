import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { OperationAccess } from "../../access.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { Route } from "../../routes/o.$orgId.p.$projectId.e.$envId.apps.$appId.tsx";
import { accessOf, APP, scope } from "./app-fixtures.tsx";

async function prefetchedBy(access: OperationAccess) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(organizationShellQuery(scope.organizationId).queryKey, {
    access,
  } as never);
  const { loader } = Route.options;
  if (typeof loader !== "function") throw new TypeError("The app route has no loader function.");
  await loader({
    context: { queryClient },
    params: {
      appId: APP,
      envId: scope.environmentId,
      orgId: scope.organizationId,
      projectId: scope.projectId,
    },
  } as never);
  return queryClient
    .getQueryCache()
    .getAll()
    .map(({ queryKey }) => queryKey)
    .filter(([root]) => root === "apps");
}

test("the app page prefetches the domain list only for a reader of it", async () => {
  const member = accessOf("member");
  const key = (...rest: string[]) => [
    "apps",
    scope.organizationId,
    scope.projectId,
    scope.environmentId,
    ...rest,
  ];
  expect({
    reader: await prefetchedBy(member),
    withoutDomains: await prefetchedBy({ ...member, listAppDomains: false }),
  }).toEqual({
    reader: [key("app", APP), key("grants", APP), key("domains", APP), key("releases", APP)],
    withoutDomains: [key("app", APP), key("grants", APP), key("releases", APP)],
  });
});
