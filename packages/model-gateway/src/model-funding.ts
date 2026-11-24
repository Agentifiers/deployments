import type { ModelGatewayProvider } from "./types.ts";

/**
 * Providers an organization can fund with its own key. A Bifrost direct key is a bare key value,
 * so Bedrock (signed with the gateway's AWS role) cannot be organization-funded.
 */
export const MODEL_CREDENTIAL_PROVIDERS = ["openai", "openrouter"] as const;

export type ModelCredentialProvider = (typeof MODEL_CREDENTIAL_PROVIDERS)[number];

/** The exact version of an organization's stored provider key that the token issuer chose. */
export interface OrganizationModelCredentialRef {
  readonly credentialId: string;
  readonly keyVersion: number;
}

/**
 * Signed into a gateway token by the issuer: the providers whose calls the token's organization
 * pays for with its own key. A provider the claim does not name is operator-funded, and so is
 * every provider of a token without the claim.
 */
export type ModelFundingClaim = Readonly<
  Partial<Record<ModelCredentialProvider, OrganizationModelCredentialRef>>
>;

export type ModelFunding =
  | { readonly kind: "operator" }
  | ({
      readonly kind: "organization";
      readonly provider: ModelCredentialProvider;
    } & OrganizationModelCredentialRef);

/** Who paid for recorded model usage, and with which organization credential. */
export type ModelUsagePayer =
  | { readonly kind: "operator" }
  | { readonly kind: "organization"; readonly modelCredentialId: string };

export interface OrganizationModelKeyRequest extends OrganizationModelCredentialRef {
  readonly organizationId: string;
  readonly provider: ModelCredentialProvider;
}

/** Thrown by a resolver that cannot read keys right now, as opposed to a key that does not exist. */
export class OrganizationModelKeyUnavailableError extends Error {
  override readonly name = "OrganizationModelKeyUnavailableError";
}

/** Reads an organization's plaintext provider key for the model gateway. */
export interface OrganizationModelKeyResolver {
  /**
   * Returns undefined when the organization has no such credential, or when it was replaced or
   * revoked since the token was issued (the key version no longer matches). Throws
   * {@link OrganizationModelKeyUnavailableError} when the key store cannot be read.
   */
  resolve(request: OrganizationModelKeyRequest): Promise<string | undefined>;
}

export function isModelCredentialProvider(value: string): value is ModelCredentialProvider {
  return (MODEL_CREDENTIAL_PROVIDERS as readonly string[]).includes(value);
}

/** Who pays for a call to `provider` under a token's funding claim. */
export function fundingForProvider(
  claim: ModelFundingClaim | undefined,
  provider: ModelGatewayProvider,
): ModelFunding {
  if (!isModelCredentialProvider(provider)) return { kind: "operator" };
  const ref = claim?.[provider];
  return ref
    ? { credentialId: ref.credentialId, keyVersion: ref.keyVersion, kind: "organization", provider }
    : { kind: "operator" };
}

/** The organization's month-to-date operator-funded model spend against its effective ceiling. */
export type OperatorModelSpend =
  | { readonly kind: "unlimited" }
  | {
      readonly ceilingUsdMicros: number;
      readonly kind: "metered";
      readonly spentUsdMicros: number;
    };

type MeteredOperatorModelSpend = Extract<OperatorModelSpend, { readonly kind: "metered" }>;

/** Spend at or above the ceiling leaves no room for another operator-funded call. */
export function operatorFundingExhausted(
  spend: OperatorModelSpend,
): spend is MeteredOperatorModelSpend {
  return spend.kind === "metered" && spend.spentUsdMicros >= spend.ceilingUsdMicros;
}

function usd(usdMicros: number) {
  return `${(usdMicros / 1_000_000).toFixed(2)} USD`;
}

/** Why `modelId` cannot be served on the operator's keys; the issuers and the gateway both say it. */
export function operatorFundingExhaustedMessage(input: {
  readonly modelId: string;
  readonly organizationId: string;
  readonly spend: MeteredOperatorModelSpend;
}) {
  const { ceilingUsdMicros, spentUsdMicros } = input.spend;
  return `Organization ${input.organizationId} has used ${usd(spentUsdMicros)} of its ${usd(ceilingUsdMicros)} monthly operator-funded model spend ceiling, so ${input.modelId} cannot be served on the operator's keys. Add the organization's own key for the provider or raise the ceiling.`;
}

/** A model a token will carry, in canonical form, with the provider that serves it. */
export interface ModelFundingCandidate {
  readonly embedding: boolean;
  readonly modelId: string;
  readonly provider: ModelGatewayProvider;
}

export type ModelFundingDecision =
  | {
      readonly claim: ModelFundingClaim;
      readonly kind: "funded";
      /** The models the token carries, in candidate order. */
      readonly modelIds: readonly string[];
    }
  | {
      readonly kind: "refused";
      /** The operator-funded primary model the exhausted ceiling refuses. */
      readonly modelId: string;
      readonly spend: MeteredOperatorModelSpend;
    };

/**
 * Decides who pays for each model a token carries. An organization credential for the model's
 * provider pays, and the returned claim names it. Embedding models are always operator-funded and
 * never refused, because stored vectors depend on them. Every other model is operator-funded while
 * the organization's ceiling has room. Once it has none, the token keeps only the models the
 * operator does not pay for, and is refused when that drops its primary, the first candidate.
 * `credentials` names the organization's active keys for the providers the install lets
 * organizations fund. `operatorSpend` is read only when some model would be operator-funded under
 * the ceiling.
 */
export async function decideModelFunding(input: {
  readonly credentials: ModelFundingClaim;
  /** The primary model first, then its fallbacks. */
  readonly models: readonly ModelFundingCandidate[];
  readonly operatorSpend: () => Promise<OperatorModelSpend>;
}): Promise<ModelFundingDecision> {
  const claim: Partial<Record<ModelCredentialProvider, OrganizationModelCredentialRef>> = {};
  const operatorFunded = new Set<string>();
  for (const model of input.models) {
    if (model.embedding) continue;
    const funding = fundingForProvider(input.credentials, model.provider);
    if (funding.kind === "organization") {
      claim[funding.provider] = {
        credentialId: funding.credentialId,
        keyVersion: funding.keyVersion,
      };
    } else {
      operatorFunded.add(model.modelId);
    }
  }
  const modelIds = input.models.map((model) => model.modelId);
  if (operatorFunded.size > 0) {
    const spend = await input.operatorSpend();
    if (operatorFundingExhausted(spend)) {
      const [primary] = modelIds;
      if (primary !== undefined && operatorFunded.has(primary)) {
        return { kind: "refused", modelId: primary, spend };
      }
      return {
        claim,
        kind: "funded",
        modelIds: modelIds.filter((modelId) => !operatorFunded.has(modelId)),
      };
    }
  }
  return { claim, kind: "funded", modelIds };
}
