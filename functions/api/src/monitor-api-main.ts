import {
  makeAlertHistory,
  makeMonitorPersistence,
  makeTenancyPersistence,
} from "@deployments-ai/db";
import { createApiLambdaHandler, makeApiIdempotency } from "./api-lambda-foundation.ts";
import { createMonitorApiHandler } from "./monitor-api.ts";

export const handler = createApiLambdaHandler((foundation, environment) => {
  const { authenticate, database, recordApiCredentialUsage } = foundation;
  const tenancy = makeTenancyPersistence({ database });
  return createMonitorApiHandler({
    authenticate,
    history: makeAlertHistory({ database }),
    idempotency: makeApiIdempotency({ database, environment }).idempotency,
    monitors: makeMonitorPersistence({ database }),
    recordApiCredentialUsage,
    resolveEnvironment: (identity, environmentId) =>
      tenancy.environments.get({
        body: undefined,
        id: environmentId,
        identity,
        query: {},
        scope: { environmentId },
      }),
  });
});
