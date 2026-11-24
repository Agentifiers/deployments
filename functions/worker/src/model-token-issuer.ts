import { normalizeModelId, type ModelTokenResponse } from "@deployments-ai/model-gateway";
import {
  modelTokenRefusal,
  type ModelTokenIssuerDependencies,
} from "./model-token-issuer-admission.ts";
import {
  isModelTokenRequestObject,
  parseModelRunTokenRequest,
  parseModelServiceTokenRequest,
} from "./model-token-issuer-request.ts";
import { issueRunModelToken } from "./model-token-issuer-run.ts";
import {
  issueServiceModelToken,
  type ModelServiceTokenIssuerConfig,
} from "./model-token-issuer-service.ts";

export const MODEL_TOKEN_ISSUER_ENV = {
  grantsParameterArn: "DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN",
  kind: "DEPLOYMENTS_AI_MODEL_TOKEN_ISSUER_KIND",
  service: "DEPLOYMENTS_AI_MODEL_TOKEN_SERVICE",
  serviceModels: "DEPLOYMENTS_AI_MODEL_TOKEN_SERVICE_MODELS",
  signingKeyArn: "DEPLOYMENTS_AI_MODEL_TOKEN_SIGNING_KEY_ARN",
  tenantModels: "DEPLOYMENTS_AI_MODEL_TOKEN_TENANT_MODELS",
} as const;

export type ModelTokenIssuerConfig = { readonly kind: "run" } | ModelServiceTokenIssuerConfig;

const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;

function requiredEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

/** The issuer's behaviour, decided only by its function environment. */
export function modelTokenIssuerConfigFromEnv(env: NodeJS.ProcessEnv): ModelTokenIssuerConfig {
  const kind = requiredEnv(env, MODEL_TOKEN_ISSUER_ENV.kind);
  if (kind === "run") return { kind };
  if (kind !== "service") {
    throw new Error(`${MODEL_TOKEN_ISSUER_ENV.kind} must be run or service.`);
  }
  const service = requiredEnv(env, MODEL_TOKEN_ISSUER_ENV.service);
  if (!SERVICE_NAME_PATTERN.test(service)) {
    throw new Error(`${MODEL_TOKEN_ISSUER_ENV.service} must be a lowercase service name.`);
  }
  const tenantModels = env[MODEL_TOKEN_ISSUER_ENV.tenantModels]?.trim() ?? "false";
  if (tenantModels !== "true" && tenantModels !== "false") {
    throw new Error(`${MODEL_TOKEN_ISSUER_ENV.tenantModels} must be true or false.`);
  }
  const serviceModels = (env[MODEL_TOKEN_ISSUER_ENV.serviceModels] ?? "")
    .split(",")
    .map((modelId) => modelId.trim())
    .filter((modelId) => modelId !== "")
    .map((modelId) => normalizeModelId(modelId));
  return {
    kind,
    service,
    serviceModels: [...new Set(serviceModels)],
    tenantModels: tenantModels === "true",
  };
}

/**
 * Handles one issuer invocation. Malformed payloads and payloads for the other issuer kind are
 * refused with `invalid_request`; policy refusals return `{ ok: false }`; infrastructure failures
 * (database, grants, signing) throw.
 */
export async function issueModelToken(
  config: ModelTokenIssuerConfig,
  dependencies: ModelTokenIssuerDependencies,
  payload: unknown,
): Promise<ModelTokenResponse> {
  if (!isModelTokenRequestObject(payload) || payload.kind !== config.kind) {
    return modelTokenRefusal(
      "invalid_request",
      `This issuer accepts only ${config.kind} token requests.`,
    );
  }
  if (config.kind === "run") {
    const parsed = parseModelRunTokenRequest(payload);
    return parsed.ok
      ? issueRunModelToken(dependencies, parsed.request)
      : modelTokenRefusal("invalid_request", parsed.message);
  }
  const parsed = parseModelServiceTokenRequest(payload);
  return parsed.ok
    ? issueServiceModelToken(config, dependencies, parsed.request)
    : modelTokenRefusal("invalid_request", parsed.message);
}
