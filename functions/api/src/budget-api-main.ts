import { makeBudgetPersistence, makeTenancyPersistence } from "@deployments-ai/db";
import { createApiLambdaHandler, makeApiIdempotency } from "./api-lambda-foundation.ts";
import { createBudgetApiHandler } from "./budget-api.ts";

export const handler = createApiLambdaHandler((foundation, environment) => {
  const { authenticate, database, recordApiCredentialUsage } = foundation;
  const persistence = makeTenancyPersistence({ database });
  return createBudgetApiHandler({
    authenticate,
    budgets: makeBudgetPersistence({ database }),
    idempotency: makeApiIdempotency({ database, environment }).idempotency,
    recordApiCredentialUsage,
    resolveEnvironment: (identity, organizationId, environmentId) =>
      persistence.environments.get({
        body: undefined,
        id: environmentId,
        identity,
        query: {},
        scope: { environmentId },
      }),
    resolveProject: (identity, organizationId, projectId) =>
      persistence.projects.get({
        body: undefined,
        id: projectId,
        identity,
        query: {},
        scope: { organizationId, projectId },
      }),
    resolveWorkspace: (identity, environmentId, workspaceId) =>
      persistence.workspaces.get({
        body: undefined,
        id: workspaceId,
        identity,
        query: {},
        scope: { environmentId },
      }),
  });
});
