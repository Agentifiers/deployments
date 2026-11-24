/**
 * `apiRequestsPerSecond <= 500` keeps one organization's rate-limit item below half of DynamoDB's
 * per-partition-key write ceiling, because every admitted request is one write.
 */
export const TENANT_LIMIT_DEFINITIONS = {
  activeSandboxes: { environmentKey: "active_sandboxes", maximum: 256, minimum: 0 },
  apiRequestBurst: { environmentKey: "api_request_burst", maximum: 1_000, minimum: 1 },
  apiRequestsPerSecond: { environmentKey: "api_requests_per_second", maximum: 500, minimum: 1 },
  concurrentRuns: { environmentKey: "concurrent_runs", maximum: 256, minimum: 1 },
} as const;

export type TenantLimitName = keyof typeof TENANT_LIMIT_DEFINITIONS;

export const TENANT_LIMIT_NAMES = Object.keys(
  TENANT_LIMIT_DEFINITIONS,
) as readonly TenantLimitName[];

export type TenantLimits = { readonly [Name in TenantLimitName]: number };

export type TenantLimitOverrides = { readonly [Name in TenantLimitName]?: number | undefined };

export type TenantLimitSource = "default" | "override";

export type EffectiveTenantLimits = {
  readonly [Name in TenantLimitName]: {
    readonly source: TenantLimitSource;
    readonly value: number;
  };
};

export const TENANT_LIMIT_DEFAULTS_ENV = "DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS";

export class TenantLimitValidationError extends Error {
  override readonly name = "TenantLimitValidationError";

  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseTenantLimitValue(name: TenantLimitName, raw: unknown): number {
  const { maximum, minimum } = TENANT_LIMIT_DEFINITIONS[name];
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < minimum || raw > maximum) {
    throw new TenantLimitValidationError(
      name,
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return raw;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertCoherentLimits(limits: TenantLimits): TenantLimits {
  if (limits.apiRequestBurst < limits.apiRequestsPerSecond) {
    throw new TenantLimitValidationError(
      "apiRequestBurst",
      "apiRequestBurst must be at least apiRequestsPerSecond.",
    );
  }
  return limits;
}

/**
 * Raises the burst to the rate when a merge of separately set limits left it below, so a grant
 * that raises the rate alone still lets a full second of requests through at once.
 */
export function coherentLimits(limits: TenantLimits): TenantLimits {
  return limits.apiRequestBurst < limits.apiRequestsPerSecond
    ? { ...limits, apiRequestBurst: limits.apiRequestsPerSecond }
    : limits;
}

export function parseTenantLimitDefaults(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const encoded = environment[TENANT_LIMIT_DEFAULTS_ENV];
  if (!encoded) {
    throw new TenantLimitValidationError(
      TENANT_LIMIT_DEFAULTS_ENV,
      `${TENANT_LIMIT_DEFAULTS_ENV} is required.`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw new TenantLimitValidationError(
      TENANT_LIMIT_DEFAULTS_ENV,
      `${TENANT_LIMIT_DEFAULTS_ENV} must be JSON.`,
    );
  }
  if (!isPlainObject(decoded)) {
    throw new TenantLimitValidationError(
      TENANT_LIMIT_DEFAULTS_ENV,
      `${TENANT_LIMIT_DEFAULTS_ENV} must be a JSON object.`,
    );
  }
  const environmentKeys = new Set<string>(
    TENANT_LIMIT_NAMES.map((name) => TENANT_LIMIT_DEFINITIONS[name].environmentKey),
  );
  const unknownKey = Object.keys(decoded).find((field) => !environmentKeys.has(field));
  if (unknownKey) {
    throw new TenantLimitValidationError(unknownKey, `${unknownKey} is not a tenant limit.`);
  }
  return assertCoherentLimits(
    Object.fromEntries(
      TENANT_LIMIT_NAMES.map((name) => [
        name,
        parseTenantLimitValue(name, decoded[TENANT_LIMIT_DEFINITIONS[name].environmentKey]),
      ]),
    ) as TenantLimits,
  );
}

export function resolveEffectiveLimits(
  defaults: TenantLimits,
  overrides: TenantLimitOverrides,
): EffectiveTenantLimits {
  return Object.fromEntries(
    TENANT_LIMIT_NAMES.map((name) => {
      const override = overrides[name];
      return [
        name,
        override === undefined
          ? { source: "default", value: defaults[name] }
          : { source: "override", value: override },
      ];
    }),
  ) as EffectiveTenantLimits;
}

export function effectiveLimitValues(effective: EffectiveTenantLimits): TenantLimits {
  return Object.fromEntries(
    TENANT_LIMIT_NAMES.map((name) => [name, effective[name].value]),
  ) as TenantLimits;
}
