import { Schema } from "effect";

export interface BrainUploadQuotas {
  readonly outstandingTickets: {
    readonly caller: number;
    readonly brain: number;
    readonly organization: number;
  };
  readonly outstandingBytes: {
    readonly caller: number;
    readonly brain: number;
    readonly organization: number;
  };
  readonly hourlyIssuance: {
    readonly caller: number;
    readonly organization: number;
  };
}

export const DEFAULT_BRAIN_UPLOAD_QUOTAS: BrainUploadQuotas = {
  outstandingTickets: { caller: 10, brain: 100, organization: 500 },
  outstandingBytes: {
    caller: 128 * 1024 * 1024,
    brain: 1024 * 1024 * 1024,
    organization: 4 * 1024 * 1024 * 1024,
  },
  hourlyIssuance: { caller: 60, organization: 500 },
};

export const BRAIN_UPLOAD_QUOTAS_ENV = "DEPLOYMENTS_AI_BRAIN_UPLOAD_QUOTAS";

const Limit = Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)));
const ScopedLimits = Schema.optionalKey(
  Schema.Struct({ brain: Limit, caller: Limit, organization: Limit }),
);

const BrainUploadQuotaOverrides = Schema.fromJsonString(
  Schema.Struct({
    hourlyIssuance: Schema.optionalKey(Schema.Struct({ caller: Limit, organization: Limit })),
    outstandingBytes: ScopedLimits,
    outstandingTickets: ScopedLimits,
  }),
);

export function parseBrainUploadQuotas(
  environment: Readonly<Record<string, string | undefined>>,
): BrainUploadQuotas {
  const encoded = environment[BRAIN_UPLOAD_QUOTAS_ENV]?.trim();
  if (!encoded) return DEFAULT_BRAIN_UPLOAD_QUOTAS;
  let overrides: typeof BrainUploadQuotaOverrides.Type;
  try {
    overrides = Schema.decodeUnknownSync(BrainUploadQuotaOverrides, {
      onExcessProperty: "error",
    })(encoded);
  } catch (cause) {
    throw new TypeError(
      `${BRAIN_UPLOAD_QUOTAS_ENV} must be a JSON object of positive integer Brain upload quotas: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  return {
    outstandingTickets: {
      ...DEFAULT_BRAIN_UPLOAD_QUOTAS.outstandingTickets,
      ...overrides.outstandingTickets,
    },
    outstandingBytes: {
      ...DEFAULT_BRAIN_UPLOAD_QUOTAS.outstandingBytes,
      ...overrides.outstandingBytes,
    },
    hourlyIssuance: {
      ...DEFAULT_BRAIN_UPLOAD_QUOTAS.hourlyIssuance,
      ...overrides.hourlyIssuance,
    },
  };
}
