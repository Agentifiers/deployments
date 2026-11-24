import {
  BEDROCK_MODEL_PREFIX,
  CURATED_PROVIDER_MODEL_IDS,
  MODEL_GATEWAY_PROVIDERS,
  ModelGatewayConfigError,
  type ModelGatewayProvider,
  type ModelGatewayRouteScope,
  OPENROUTER_MODEL_PREFIX,
  isRecord,
  optionalString,
} from "./types.ts";

/** Environment value the deploy tool reads the operator grants from. */
export const MODEL_OPERATOR_GRANTS_ENV = "DEPLOYMENTS_AI_MODEL_GRANTS_JSON";

/**
 * Providers an operator grant serves when it lists none. Bedrock has no curated models, so a grant
 * reaches it only by naming it in `providers`.
 */
export const DEFAULT_OPERATOR_GRANT_PROVIDERS: readonly ModelGatewayProvider[] = [
  "openai",
  "openrouter",
];

/** The `organizationId` of a grant that applies to every organization in the deployment. */
const DEPLOYMENT_WIDE_ORGANIZATION_ID = "*";

/**
 * An operator model grant: a scope (agent definition, workspace, organization, or the whole
 * deployment with `organizationId: "*"`), the providers it serves, and the models it allows.
 * Explicit `allowedModels` admit models the environment model policy does not; an omitted list or
 * `"*"` means only the curated models, which grant nothing beyond the curated defaults.
 */
export interface ModelOperatorGrant {
  readonly agentId?: string;
  readonly allowedModels?: readonly string[];
  readonly organizationId?: string;
  readonly providers?: readonly ModelGatewayProvider[];
  readonly workspaceId?: string;
}

function grantError(message: string) {
  return new ModelGatewayConfigError({ key: MODEL_OPERATOR_GRANTS_ENV, message });
}

/** Parses and validates the operator grants JSON array; an empty value means no grants. */
export function parseModelOperatorGrantsJson(
  value: string | undefined,
): readonly ModelOperatorGrant[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw grantError(cause instanceof Error ? cause.message : "Model grants JSON is invalid.");
  }
  if (!Array.isArray(parsed)) throw grantError("Model grants JSON must be an array.");
  return parsed.map((entry: unknown, index) => {
    if (!isRecord(entry)) throw grantError(`Model grant ${index} must be an object.`);
    const unknownField = Object.keys(entry).find(
      (field) =>
        !["agentId", "allowedModels", "organizationId", "providers", "workspaceId"].includes(field),
    );
    if (unknownField) {
      throw grantError(`Model grant ${index} has unsupported field ${unknownField}.`);
    }
    const scopeField = (field: "agentId" | "organizationId" | "workspaceId") => {
      const candidate = entry[field];
      if (candidate === undefined) return undefined;
      const text = optionalString(candidate);
      if (!text) throw grantError(`Model grant ${index} ${field} must be a non-empty string.`);
      return text;
    };
    const textList = (field: "allowedModels" | "providers") => {
      const candidate = entry[field];
      if (candidate === undefined) return undefined;
      if (
        !Array.isArray(candidate) ||
        candidate.length === 0 ||
        candidate.some((item) => !optionalString(item))
      ) {
        throw grantError(`Model grant ${index} ${field} must be a non-empty list of strings.`);
      }
      return [...new Set(candidate.map((item) => optionalString(item)!))];
    };
    const agentId = scopeField("agentId");
    const organizationId = scopeField("organizationId");
    const workspaceId = scopeField("workspaceId");
    if (!agentId && !organizationId && !workspaceId) {
      throw grantError(`Model grant ${index} must include a scope.`);
    }
    if (organizationId === DEPLOYMENT_WIDE_ORGANIZATION_ID && (agentId || workspaceId)) {
      throw grantError(
        `Model grant ${index} with organizationId "${DEPLOYMENT_WIDE_ORGANIZATION_ID}" applies to every organization and cannot include workspaceId or agentId.`,
      );
    }
    const providers = textList("providers");
    const unsupported = providers?.find(
      (provider) => !MODEL_GATEWAY_PROVIDERS.includes(provider as ModelGatewayProvider),
    );
    if (unsupported) {
      throw grantError(`Model grant ${index} lists unsupported provider ${unsupported}.`);
    }
    const allowedModels = textList("allowedModels");
    return {
      ...(agentId ? { agentId } : {}),
      ...(allowedModels ? { allowedModels } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(providers ? { providers: providers as ModelGatewayProvider[] } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
  });
}

/** The providers a grant serves: its explicit list or the defaults. */
export function operatorGrantProviders(grant: ModelOperatorGrant) {
  return grant.providers ?? DEFAULT_OPERATOR_GRANT_PROVIDERS;
}

/**
 * How specifically a grant matches a scope: agent 4, workspace 3, organization 2, deployment-wide
 * 1 (only for a scope that names an organization), and 0 when it does not apply.
 */
function grantScopeScore(grant: ModelOperatorGrant, scope: ModelGatewayRouteScope) {
  const organizationId = optionalString(grant.organizationId);
  const workspaceId = optionalString(grant.workspaceId);
  const agentId = optionalString(grant.agentId);
  if (organizationId === DEPLOYMENT_WIDE_ORGANIZATION_ID) {
    return optionalString(scope.organizationId) ? 1 : 0;
  }
  if (organizationId && organizationId !== optionalString(scope.organizationId)) return 0;
  if (workspaceId && workspaceId !== optionalString(scope.workspaceId)) return 0;
  if (agentId && agentId !== optionalString(scope.agentId)) return 0;
  if (agentId) return 4;
  if (workspaceId) return 3;
  if (organizationId) return 2;
  return 0;
}

function allowedModelsMatch(
  allowedModels: readonly string[],
  provider: ModelGatewayProvider,
  modelId: string,
) {
  const normalizedModelId = modelId.toLowerCase();
  return allowedModels.some((allowedModel) => {
    const normalizedAllowedModel = allowedModel.trim().toLowerCase();
    return (
      normalizedAllowedModel === normalizedModelId ||
      `${provider}/${normalizedAllowedModel}` === normalizedModelId
    );
  });
}

/** Whether a grant's allowlist (curated defaults for an omitted list or `"*"`) covers a model. */
function grantCoversModel(
  grant: ModelOperatorGrant,
  provider: ModelGatewayProvider,
  modelId: string,
) {
  const configured = grant.allowedModels;
  const allowedModels =
    !configured || configured.includes("*")
      ? [
          ...CURATED_PROVIDER_MODEL_IDS[provider],
          ...(configured ?? []).filter((allowedModel) => allowedModel !== "*"),
        ]
      : configured;
  return allowedModelsMatch(allowedModels, provider, modelId);
}

/**
 * Selects the grant that decides a model for a scope: among the grants serving the model's
 * provider, only the most specific matching scope (agent, then workspace, then organization, then
 * deployment-wide) competes, and the first of those whose allowlist covers the model wins.
 */
function selectOperatorGrant(
  grants: readonly ModelOperatorGrant[],
  scope: ModelGatewayRouteScope,
  provider: ModelGatewayProvider,
  modelId: string,
) {
  let selected: ModelOperatorGrant | undefined;
  let highestScore = 0;
  for (const grant of grants) {
    if (!operatorGrantProviders(grant).includes(provider)) continue;
    const score = grantScopeScore(grant, scope);
    if (score === 0 || score < highestScore) continue;
    if (score > highestScore) {
      highestScore = score;
      selected = undefined;
    }
    if (!selected && grantCoversModel(grant, provider, modelId)) selected = grant;
  }
  return selected;
}

/** The provider a canonical platform model id belongs to. */
export function operatorGrantModelProvider(modelId: string): ModelGatewayProvider {
  const lower = modelId.toLowerCase();
  if (lower.startsWith(BEDROCK_MODEL_PREFIX)) return "bedrock";
  return lower.startsWith(OPENROUTER_MODEL_PREFIX) ? "openrouter" : "openai";
}

/**
 * Whether an operator grant admits a canonical platform model id for a scope: the grant selected
 * for the scope lists the model explicitly. Curated allowances (`allowedModels` absent or `*`)
 * are not grants.
 */
export function operatorGrantAllowsModel(
  grants: readonly ModelOperatorGrant[],
  scope: ModelGatewayRouteScope,
  modelId: string,
) {
  const provider = operatorGrantModelProvider(modelId);
  const selected = selectOperatorGrant(grants, scope, provider, modelId);
  if (!selected) return false;
  const explicitModels = (selected.allowedModels ?? []).filter(
    (allowedModel) => allowedModel.trim() !== "*",
  );
  return allowedModelsMatch(explicitModels, provider, modelId);
}
