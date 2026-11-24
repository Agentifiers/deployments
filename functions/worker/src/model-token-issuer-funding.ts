import {
  listModelProviderCredentials,
  readOperatorFundedModelSpend,
  type DynamoDatabaseService,
  type InstallDefaults,
  type Ulid,
} from "@deployments-ai/db";
import {
  decideModelFunding,
  isModelCredentialProvider,
  modelProviderForId,
  normalizeModelId,
  operatorFundingExhaustedMessage,
  type ModelCredentialProvider,
  type ModelFundingClaim,
  type ModelTokenResponse,
  type OrganizationModelCredentialRef,
} from "@deployments-ai/model-gateway";
import { parseInstallDefaultEntitlements } from "@deployments-ai/tenant-limits/install-defaults";

export const MODEL_TOKEN_FUNDING_ENV = {
  credentialProviders: "DEPLOYMENTS_AI_MODEL_CREDENTIAL_PROVIDERS",
  embeddingModels: "DEPLOYMENTS_AI_MODEL_TOKEN_EMBEDDING_MODELS",
} as const;

/** How an install funds model calls; decided only by the issuer's environment. */
export interface ModelTokenFundingConfig {
  /** Providers organizations may pay for with their own key; empty leaves every call operator-funded. */
  readonly credentialProviders: ReadonlySet<ModelCredentialProvider>;
  /** Lowercased canonical ids of the embedding models; they are never organization-funded or refused. */
  readonly embeddingModelIds: ReadonlySet<string>;
  /** The entitlements of an organization without a grant. */
  readonly installDefaults: InstallDefaults;
}

function listEnv(env: NodeJS.ProcessEnv, name: string) {
  return (env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** Reads the funding configuration. An unset ceiling leaves operator-funded spend unlimited. */
export function modelTokenFundingConfigFromEnv(env: NodeJS.ProcessEnv): ModelTokenFundingConfig {
  const providers = listEnv(env, MODEL_TOKEN_FUNDING_ENV.credentialProviders);
  const unknown = providers.find((provider) => !isModelCredentialProvider(provider));
  if (unknown !== undefined) {
    throw new Error(
      `${MODEL_TOKEN_FUNDING_ENV.credentialProviders} lists ${unknown}, which organizations cannot fund with their own key.`,
    );
  }
  return {
    credentialProviders: new Set(providers.filter(isModelCredentialProvider)),
    embeddingModelIds: new Set(
      listEnv(env, MODEL_TOKEN_FUNDING_ENV.embeddingModels).map((modelId) =>
        normalizeModelId(modelId).toLowerCase(),
      ),
    ),
    installDefaults: parseInstallDefaultEntitlements(env),
  };
}

interface FundingDependencies {
  readonly database: DynamoDatabaseService;
  readonly funding: ModelTokenFundingConfig;
  readonly now: () => Date;
}

/** The organization's active keys for the providers this install lets organizations fund. */
export async function organizationModelCredentials(
  dependencies: Pick<FundingDependencies, "database" | "funding">,
  organizationId: Ulid,
): Promise<ModelFundingClaim> {
  const { credentialProviders } = dependencies.funding;
  if (credentialProviders.size === 0) return {};
  const credentials: Partial<Record<ModelCredentialProvider, OrganizationModelCredentialRef>> = {};
  for (const credential of await listModelProviderCredentials(
    dependencies.database,
    organizationId,
  )) {
    if (credential.status !== "active" || !credentialProviders.has(credential.provider)) continue;
    credentials[credential.provider] = {
      credentialId: credential.credentialId,
      keyVersion: credential.keyVersion,
    };
  }
  return credentials;
}

/**
 * Decides the funding claim and models of a token for `organizationId` carrying `modelIds`
 * (canonical ids, the primary first). The claim is absent when the operator pays for every model.
 * Once the organization's month-to-date operator-funded spend reaches its effective ceiling, read
 * strongly consistent from its standing and spend shards, the token drops its operator-funded
 * fallbacks and is refused when its primary is operator-funded.
 */
export async function fundModelToken(
  dependencies: FundingDependencies,
  organizationId: Ulid,
  credentials: ModelFundingClaim,
  modelIds: readonly string[],
): Promise<
  | {
      readonly funding?: ModelFundingClaim;
      readonly models: readonly string[];
      readonly ok: true;
    }
  | { readonly ok: false; readonly refusal: ModelTokenResponse }
> {
  const { database, funding, now } = dependencies;
  const decision = await decideModelFunding({
    credentials,
    models: modelIds.map((modelId) => ({
      embedding: funding.embeddingModelIds.has(modelId.toLowerCase()),
      modelId,
      provider: modelProviderForId(modelId),
    })),
    operatorSpend: () =>
      readOperatorFundedModelSpend(database, organizationId, {
        asOf: now(),
        defaultCeiling: funding.installDefaults.operatorFundedModelSpendCeiling,
      }),
  });
  if (decision.kind === "refused") {
    return {
      ok: false,
      refusal: {
        code: "operator_funding_exhausted",
        message: operatorFundingExhaustedMessage({
          modelId: decision.modelId,
          organizationId,
          spend: decision.spend,
        }),
        ok: false,
      },
    };
  }
  return Object.keys(decision.claim).length === 0
    ? { models: decision.modelIds, ok: true }
    : { funding: decision.claim, models: decision.modelIds, ok: true };
}
