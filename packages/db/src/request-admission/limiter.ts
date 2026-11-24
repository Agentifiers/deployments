import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { makeOrganizationRequestLimiter } from "@deployments-ai/tenant-limits";
import { makeRequestAdmissionStore } from "./store.ts";

export const REQUEST_ADMISSION_TABLE_ENV = "DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE";

/**
 * `client` must be the composition root's DynamoDB client, the one behind `database`. The
 * admission store is a single-attempt view of it that sends through its connection pool: a pool
 * of its own would open a new TLS connection inside the 150 ms admission budget on the first
 * request of every execution environment, and that request would fail open.
 */
export function makeOrganizationRequestLimiterFromEnvironment(input: {
  readonly client: {
    readonly config: Pick<DynamoDBClient["config"], "credentials" | "region" | "requestHandler">;
  };
  readonly environment: Readonly<Record<string, string | undefined>>;
}) {
  const tableName = input.environment[REQUEST_ADMISSION_TABLE_ENV]?.trim();
  if (!tableName) throw new Error(`${REQUEST_ADMISSION_TABLE_ENV} is required.`);
  return makeOrganizationRequestLimiter({
    service: input.environment.AWS_LAMBDA_FUNCTION_NAME?.trim() || "local",
    store: makeRequestAdmissionStore({
      client: new DynamoDBClient({
        credentials: input.client.config.credentials,
        maxAttempts: 1,
        region: input.client.config.region,
        requestHandler: input.client.config.requestHandler,
      }),
      tableName,
    }),
  });
}
