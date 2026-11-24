import {
  boundaryAdmitsModel,
  makeModelCatalogPersistence,
  makeModelPolicyPersistence,
  makeOrganizationDataBoundaryReader,
  makeOrganizationHoldReader,
  type DynamoDatabaseService,
  type LoadModelOperatorGrants,
  type Ulid,
} from "@deployments-ai/db";
import {
  admitModelReferences,
  admittedModelIds,
  catalogLookupModelIds,
  effectiveModelPolicy,
  fundingForProvider,
  modelProviderForId,
  normalizeModelId,
  parseModelOperatorGrantsJson,
  type ModelFundingClaim,
  type ModelGatewayRouteScope,
  type ModelOperatorGrant,
  type ModelTokenRefusal,
  type ModelTokenResponse,
} from "@deployments-ai/model-gateway";
import { admitConsistently } from "@deployments-ai/organization-admission";
import type { ModelTokenFundingConfig } from "./model-token-issuer-funding.ts";
import type { ModelTokenSigner } from "./model-token-signer.ts";

/** Everything an issuer reads or calls; injected so issuance is testable without AWS. */
export interface ModelTokenIssuerDependencies {
  readonly database: DynamoDatabaseService;
  readonly funding: ModelTokenFundingConfig;
  /** The token's `jti`. */
  readonly generateTokenId: () => string;
  readonly loadOperatorGrants: LoadModelOperatorGrants;
  readonly now: () => Date;
  readonly signer: ModelTokenSigner;
}

/** Operator grants are re-read at most this often per container. */
const MODEL_OPERATOR_GRANTS_CACHE_MS = 60_000;

export function modelTokenRefusal(code: ModelTokenRefusal, message: string): ModelTokenResponse {
  return { code, message, ok: false };
}

/**
 * Refuses the token while the organization's standing refuses `activity`, read strongly
 * consistently. A failed read fails the invocation, so no token is minted on unknown standing.
 */
export async function standingRefusal(
  dependencies: Pick<ModelTokenIssuerDependencies, "database">,
  organizationId: Ulid,
  activity: "model.mint" | "run.continue",
): Promise<ModelTokenResponse | undefined> {
  const { decision } = await admitConsistently({
    activity,
    organizationId,
    standing: makeOrganizationHoldReader(dependencies.database),
  });
  return decision.kind === "suspended"
    ? modelTokenRefusal("organization_suspended", `Organization ${organizationId} is suspended.`)
    : undefined;
}

/**
 * Refuses the token when the organization's data boundary does not admit every model's provider,
 * read strongly consistently. A failed read fails the invocation, so no token is minted on an
 * unknown boundary.
 */
export async function dataBoundaryRefusal(
  dependencies: Pick<ModelTokenIssuerDependencies, "database">,
  organizationId: Ulid,
  models: readonly string[],
): Promise<ModelTokenResponse | undefined> {
  const boundary = await makeOrganizationDataBoundaryReader(dependencies.database).read(
    organizationId,
  );
  const denied = models.filter((modelId) => !boundaryAdmitsModel(boundary, modelId));
  if (denied.length === 0) return undefined;
  return modelTokenRefusal(
    "model_outside_data_boundary",
    `Organization ${organizationId}'s ${boundary.profile} data boundary allows only ${[...boundary.modelProviders].join(", ")} models; ${denied.join(", ")} is outside it.`,
  );
}

/** The environment whose model policy admits models, and the grant scope of the caller. */
export interface ModelTokenAdmissionScope {
  readonly environment: {
    readonly environmentId: string;
    readonly organizationId: string;
    readonly projectId: string;
  };
  readonly grantScope: ModelGatewayRouteScope;
}

/**
 * Admits model references the way the agent worker does: the environment's active model policy
 * (or the curated defaults), the synchronized catalog, then the operator grants for the scope.
 * Operator grants admit only operator-funded calls, so a model the organization pays for with its
 * own key (`credentials`) needs the policy and catalog. Any denied reference refuses issuance with
 * `model_not_admitted`.
 */
export async function admitEnvironmentModels(
  dependencies: Pick<ModelTokenIssuerDependencies, "database" | "loadOperatorGrants">,
  scope: ModelTokenAdmissionScope,
  modelIds: readonly string[],
  credentials: ModelFundingClaim,
): Promise<
  | { readonly models: readonly string[]; readonly ok: true }
  | { readonly ok: false; readonly refusal: ModelTokenResponse }
> {
  const [activePolicy, catalogEntries, grants] = await Promise.all([
    makeModelPolicyPersistence(dependencies.database).getActive(scope.environment),
    makeModelCatalogPersistence(dependencies.database).getEntries(catalogLookupModelIds(modelIds)),
    dependencies.loadOperatorGrants(),
  ]);
  const policy = effectiveModelPolicy(activePolicy);
  const operatorGrants = grants.length > 0 ? { grants, scope: scope.grantScope } : undefined;
  const admissions = modelIds.flatMap((modelId) => {
    let organizationFunded = false;
    try {
      organizationFunded =
        fundingForProvider(credentials, modelProviderForId(normalizeModelId(modelId))).kind ===
        "organization";
    } catch {
      // Admission refuses the invalid id below.
    }
    return admitModelReferences(
      [modelId],
      policy,
      catalogEntries,
      organizationFunded ? undefined : operatorGrants,
    ).admissions;
  });
  const denied = admissions.flatMap((admission) =>
    admission.allowed ? [] : [`${admission.modelId} (${admission.reason}): ${admission.message}`],
  );
  if (denied.length > 0) {
    return {
      ok: false,
      refusal: modelTokenRefusal(
        "model_not_admitted",
        `Models are not admitted in this environment: ${denied.join("; ")}`,
      ),
    };
  }
  return { models: admittedModelIds(admissions), ok: true };
}

/**
 * Loads the operator grants JSON at most once per {@link MODEL_OPERATOR_GRANTS_CACHE_MS}.
 * Concurrent callers share one read; a failed read is not cached.
 */
export function cachedModelOperatorGrants(
  loadJson: () => Promise<string>,
  now: () => number = Date.now,
): LoadModelOperatorGrants {
  let cached:
    | { readonly grants: Promise<readonly ModelOperatorGrant[]>; readonly loadedAt: number }
    | undefined;
  return () => {
    const current = now();
    if (cached && current - cached.loadedAt < MODEL_OPERATOR_GRANTS_CACHE_MS) {
      return cached.grants;
    }
    const entry = {
      grants: loadJson().then((json) => parseModelOperatorGrantsJson(json)),
      loadedAt: current,
    };
    cached = entry;
    entry.grants.catch(() => {
      if (cached === entry) cached = undefined;
    });
    return entry.grants;
  };
}
