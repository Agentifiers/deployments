import { Ulid } from "@deployments-ai/db";
import {
  agentModelGrantScope,
  MODEL_GATEWAY_SERVICE_TOKEN_TTL_SECONDS,
  normalizeModelId,
  type ModelFundingClaim,
  type ModelRunLease,
  type ModelServiceTokenRequest,
  type ModelTokenResponse,
} from "@deployments-ai/model-gateway";
import { Schema } from "effect";
import {
  admitEnvironmentModels,
  dataBoundaryRefusal,
  modelTokenRefusal,
  standingRefusal,
  type ModelTokenIssuerDependencies,
} from "./model-token-issuer-admission.ts";
import { fundModelToken, organizationModelCredentials } from "./model-token-issuer-funding.ts";
import { claimedRunningRun } from "./model-token-issuer-run.ts";
import { mintModelGatewayToken } from "./model-token-signer.ts";

/** A service issuer's deploy-time configuration. */
export interface ModelServiceTokenIssuerConfig {
  readonly kind: "service";
  readonly service: string;
  /** Canonical model ids the service may always call. */
  readonly serviceModels: readonly string[];
  /** Whether the service may request other models its tenant environment admits. */
  readonly tenantModels: boolean;
}

/**
 * Refuses a token for a suspended organization, by what the token is for. Embedding models are
 * operator-funded infrastructure that reads allowed under any hold depend on, so a token of only
 * embedding models is never refused. A token for a running run follows the run's standing, so a
 * payment hold lets the run finish. Any other token is new spending and is refused under any hold.
 */
async function serviceStandingRefusal(
  dependencies: ModelTokenIssuerDependencies,
  organizationId: Ulid,
  models: readonly string[],
  run: ModelRunLease | undefined,
): Promise<ModelTokenResponse | undefined> {
  const { embeddingModelIds } = dependencies.funding;
  if (models.every((model) => embeddingModelIds.has(model.toLowerCase()))) return undefined;
  if (!run) return standingRefusal(dependencies, organizationId, "model.mint");
  const claimed = await claimedRunningRun(dependencies, run);
  if (!claimed.ok) return claimed.refusal;
  return standingRefusal(dependencies, organizationId, "run.continue");
}

/**
 * Mints a service token. Requested models default to the configured service models; every other
 * requested model needs tenant models enabled and a context naming the environment whose policy,
 * catalog, and operator grants (under the context's agent grant scope) admit it. A context that
 * names an organization also decides who pays for each model, as for run tokens, and is admitted
 * by the organization's standing ({@link serviceStandingRefusal}).
 */
export async function issueServiceModelToken(
  config: ModelServiceTokenIssuerConfig,
  dependencies: ModelTokenIssuerDependencies,
  request: ModelServiceTokenRequest,
): Promise<ModelTokenResponse> {
  const requested = request.models ?? config.serviceModels;
  if (requested.length === 0) {
    return modelTokenRefusal(
      "invalid_request",
      `Service ${config.service} has no configured models; the request must name the models it needs.`,
    );
  }
  // Model ids compare case-insensitively (as the gateway checks them); a configured service model
  // keeps its configured spelling.
  const models: string[] = [];
  const tenantModelIds: string[] = [];
  for (const requestedModelId of requested) {
    let modelId: string;
    try {
      modelId = normalizeModelId(requestedModelId);
    } catch (cause) {
      return modelTokenRefusal(
        "model_not_admitted",
        cause instanceof Error ? cause.message : `Model ${requestedModelId} is invalid.`,
      );
    }
    const key = modelId.toLowerCase();
    if (models.some((model) => model.toLowerCase() === key)) continue;
    const serviceModel = config.serviceModels.find((model) => model.toLowerCase() === key);
    models.push(serviceModel ?? modelId);
    if (!serviceModel) tenantModelIds.push(modelId);
  }
  const context = request.context ?? {};
  const organizationId =
    context.organizationId === undefined
      ? undefined
      : Schema.decodeUnknownSync(Ulid)(context.organizationId);
  // The boundary alone falls back to the run's organization; funding and standing keep following
  // the context.
  const boundaryOrganizationId =
    organizationId ??
    (request.run === undefined
      ? undefined
      : Schema.decodeUnknownSync(Ulid)(request.run.organizationId));
  if (boundaryOrganizationId) {
    const outsideBoundary = await dataBoundaryRefusal(dependencies, boundaryOrganizationId, models);
    if (outsideBoundary) return outsideBoundary;
  }
  if (organizationId) {
    const refused = await serviceStandingRefusal(dependencies, organizationId, models, request.run);
    if (refused) return refused;
  }
  const credentials = organizationId
    ? await organizationModelCredentials(dependencies, organizationId)
    : {};
  if (tenantModelIds.length > 0) {
    if (!config.tenantModels) {
      return modelTokenRefusal(
        "model_not_admitted",
        `Service ${config.service} may call only its configured models; ${tenantModelIds.join(", ")} is not one of them.`,
      );
    }
    const { environmentId, projectId } = context;
    if (!organizationId || !projectId || !environmentId) {
      return modelTokenRefusal(
        "model_not_admitted",
        `Models ${tenantModelIds.join(", ")} need a context naming the organization, project, and environment that admits them.`,
      );
    }
    const admission = await admitEnvironmentModels(
      dependencies,
      {
        environment: { environmentId, organizationId, projectId },
        grantScope: agentModelGrantScope({
          agentDefinitionId: context.agentDefinitionId,
          organizationId,
          workspaceId: context.workspaceId,
        }),
      },
      tenantModelIds,
      credentials,
    );
    if (!admission.ok) return admission.refusal;
  }
  let funding: ModelFundingClaim | undefined;
  let tokenModels: readonly string[] = models;
  if (organizationId) {
    const funded = await fundModelToken(dependencies, organizationId, credentials, models);
    if (!funded.ok) return funded.refusal;
    funding = funded.funding;
    tokenModels = funded.models;
  }
  return mintModelGatewayToken(
    dependencies,
    {
      ...context,
      ...(funding ? { funding } : {}),
      kind: "service",
      models: tokenModels,
      service: config.service,
      sub: `service:${config.service}`,
    },
    MODEL_GATEWAY_SERVICE_TOKEN_TTL_SECONDS,
  );
}
