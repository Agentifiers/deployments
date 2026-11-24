import {
  parseTenantLimitDefaults,
  TenantLimitValidationError,
  type TenantLimits,
} from "./limits.ts";

export const OPERATOR_FUNDED_MODEL_SPEND_CEILING_ENV =
  "DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS";

export type ModelSpendCeiling = "unlimited" | { readonly monthlyUsdMicros: number };

/** What an organization with no grant may use. */
export interface InstallDefaultEntitlements {
  readonly operatorFundedModelSpendCeiling: ModelSpendCeiling;
  readonly tenantLimits: TenantLimits;
}

/** The install's default ceiling; unset leaves operator-funded model spend unlimited. */
export function parseOperatorFundedModelSpendCeiling(
  environment: Readonly<Record<string, string | undefined>>,
): ModelSpendCeiling {
  const encoded = environment[OPERATOR_FUNDED_MODEL_SPEND_CEILING_ENV];
  if (encoded === undefined || encoded === "") return "unlimited";
  const monthlyUsdMicros = Number(encoded);
  if (!/^\d+$/u.test(encoded) || !Number.isSafeInteger(monthlyUsdMicros)) {
    throw new TenantLimitValidationError(
      OPERATOR_FUNDED_MODEL_SPEND_CEILING_ENV,
      `${OPERATOR_FUNDED_MODEL_SPEND_CEILING_ENV} must be a whole number of USD micros.`,
    );
  }
  return { monthlyUsdMicros };
}

export function parseInstallDefaultEntitlements(
  environment: Readonly<Record<string, string | undefined>>,
): InstallDefaultEntitlements {
  return {
    operatorFundedModelSpendCeiling: parseOperatorFundedModelSpendCeiling(environment),
    tenantLimits: parseTenantLimitDefaults(environment),
  };
}
