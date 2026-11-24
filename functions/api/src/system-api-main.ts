import { createApiLambdaHandler } from "./api-lambda-foundation.ts";
import { makeSystemOperatorFetch } from "./system/runtime.ts";

export const handler = createApiLambdaHandler(({ authenticate, database }, environment) =>
  makeSystemOperatorFetch({ authenticate, database, environment }),
);
