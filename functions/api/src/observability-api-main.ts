import { loadAwsSecretString, parseAwsSecretReference } from "@deployments-ai/secret-store";
import { createApiLambdaHandler } from "./api-lambda-foundation.ts";
import { optionalPair } from "./lambda-environment.ts";
import { createObservabilityApi, createUnavailableObservabilityApi } from "./observability-api.ts";

const OBSERVABILITY_API_ENV = {
  baseUrl: "DEPLOYMENTS_AI_OBSERVABILITY_BASE_URL",
  secretArn: "DEPLOYMENTS_AI_OBSERVABILITY_SECRET_ARN",
  secretVersionId: "DEPLOYMENTS_AI_OBSERVABILITY_SECRET_VERSION_ID",
} as const;

async function secretValue(arn: string, versionId: string | undefined) {
  const value = (
    await loadAwsSecretString(
      arn,
      versionId && parseAwsSecretReference(arn).kind === "secret" ? { versionId } : {},
    )
  ).trim();
  try {
    const parsed = JSON.parse(value) as Readonly<Record<string, unknown>>;
    const candidate = parsed.apiKey ?? parsed.serviceToken ?? parsed.value ?? parsed.token;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : value;
  } catch {
    return value;
  }
}

export const handler = createApiLambdaHandler((foundation, environment) => {
  const { authenticate, recordApiCredentialUsage } = foundation;
  const observability = optionalPair(
    environment,
    OBSERVABILITY_API_ENV.baseUrl,
    OBSERVABILITY_API_ENV.secretArn,
  );
  const secretVersionId = environment[OBSERVABILITY_API_ENV.secretVersionId]?.trim();
  if (!observability) {
    if (secretVersionId) {
      throw new Error(
        `${OBSERVABILITY_API_ENV.secretVersionId} requires ${OBSERVABILITY_API_ENV.baseUrl} and ${OBSERVABILITY_API_ENV.secretArn}.`,
      );
    }
    return createUnavailableObservabilityApi({ authenticate, recordApiCredentialUsage });
  }
  return createObservabilityApi({
    authenticate,
    baseUrl: observability[0],
    recordApiCredentialUsage,
    serviceToken: () => secretValue(observability[1], secretVersionId),
  });
});
