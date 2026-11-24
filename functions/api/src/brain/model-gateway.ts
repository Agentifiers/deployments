import { LambdaClient } from "@aws-sdk/client-lambda";
import {
  lambdaModelTokenIssuer,
  makeModelGateway,
  modelGatewayRouteDefaultsFromEnv,
  modelGatewayServiceCredentials,
} from "@deployments-ai/model-gateway";

export const BRAIN_MODEL_GATEWAY_ENV = {
  baseUrl: "DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL",
  tokenIssuer: "DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER",
} as const;

/**
 * A gateway authenticated by the `brain` service token issuer. Brain calls are organization-scoped,
 * so each token carries the request's organization.
 */
export function makeBrainModelGateway(input: {
  readonly baseUrl: string;
  /** Supplies the deployment's default model and fallbacks (`MODEL_GATEWAY_ENV_KEYS`). */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly lambda?: Pick<LambdaClient, "send">;
  readonly tokenIssuer: string;
}) {
  return makeModelGateway({
    baseUrl: input.baseUrl,
    credentials: modelGatewayServiceCredentials({
      context: ({ scope }) =>
        scope?.organizationId ? { organizationId: scope.organizationId } : undefined,
      issue: lambdaModelTokenIssuer(input.lambda ?? new LambdaClient({}), input.tokenIssuer),
    }),
    ...modelGatewayRouteDefaultsFromEnv(input.environment),
  });
}
