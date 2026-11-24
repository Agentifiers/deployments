import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { environmentQuery } from "../data/console-queries.ts";

/**
 * Environment context for every environment screen: the loader resolves the environment and
 * renders not-found when it does not belong to the organization and project in the URL.
 */
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId")({
  beforeLoad: ({ params }) => {
    if (![params.projectId, params.envId].every((id) => PUBLIC_ID_PATTERN.test(id))) {
      throw notFound();
    }
  },
  component: Outlet,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      environmentQuery({
        environmentId: params.envId,
        organizationId: params.orgId,
        projectId: params.projectId,
      }),
    ),
});
