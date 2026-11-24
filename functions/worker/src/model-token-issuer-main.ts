import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "@deployments-ai/db";
import type { ModelTokenResponse } from "@deployments-ai/model-gateway";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { randomUUID } from "node:crypto";
import {
  issueModelToken,
  MODEL_TOKEN_ISSUER_ENV,
  modelTokenIssuerConfigFromEnv,
  type ModelTokenIssuerConfig,
} from "./model-token-issuer.ts";
import {
  cachedModelOperatorGrants,
  type ModelTokenIssuerDependencies,
} from "./model-token-issuer-admission.ts";
import { modelTokenFundingConfigFromEnv } from "./model-token-issuer-funding.ts";
import { kmsModelTokenSigner } from "./model-token-signer.ts";

interface ModelTokenIssuerRuntime {
  readonly config: ModelTokenIssuerConfig;
  readonly dependencies: ModelTokenIssuerDependencies;
}

function modelTokenIssuerRuntimeFromEnvironment(env: NodeJS.ProcessEnv): ModelTokenIssuerRuntime {
  const config = modelTokenIssuerConfigFromEnv(env);
  const signingKeyArn = env[MODEL_TOKEN_ISSUER_ENV.signingKeyArn]?.trim();
  if (!signingKeyArn) throw new Error(`${MODEL_TOKEN_ISSUER_ENV.signingKeyArn} is required.`);
  // Only run admission and tenant models consult operator grants.
  const usesOperatorGrants = config.kind === "run" || config.tenantModels;
  const grantsParameterArn = env[MODEL_TOKEN_ISSUER_ENV.grantsParameterArn]?.trim();
  if (usesOperatorGrants && !grantsParameterArn) {
    throw new Error(`${MODEL_TOKEN_ISSUER_ENV.grantsParameterArn} is required.`);
  }
  return {
    config,
    dependencies: {
      database: makeDynamoDatabase(
        DynamoDBDocumentClient.from(new DynamoDBClient({}), {
          marshallOptions: { removeUndefinedValues: true },
        }),
        tableNamesFromEnvironment(env),
      ),
      funding: modelTokenFundingConfigFromEnv(env),
      generateTokenId: randomUUID,
      loadOperatorGrants:
        usesOperatorGrants && grantsParameterArn
          ? cachedModelOperatorGrants(() => loadAwsSecretString(grantsParameterArn))
          : async () => [],
      now: () => new Date(),
      signer: kmsModelTokenSigner(new KMSClient({}), signingKeyArn),
    },
  };
}

let runtime: ModelTokenIssuerRuntime | undefined;

/**
 * Model gateway token issuer. One handler serves every issuer function; its environment selects
 * run or service issuance. Refusals are returned; infrastructure failures throw so the caller sees
 * a function error. Tokens are never logged.
 */
export async function handler(event: unknown): Promise<ModelTokenResponse> {
  runtime ??= modelTokenIssuerRuntimeFromEnvironment(process.env);
  const response = await issueModelToken(runtime.config, runtime.dependencies, event);
  if (!response.ok) {
    console.warn(
      JSON.stringify({
        code: response.code,
        event: "model_token_refused",
        issuer: runtime.config.kind === "run" ? "run" : runtime.config.service,
        message: response.message,
      }),
    );
  }
  return response;
}
