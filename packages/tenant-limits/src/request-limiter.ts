import { decideGcra, gcraParameters, retryAfterSeconds, type GcraParameters } from "./gcra.ts";
import type { TenantLimits } from "./limits.ts";
import { requestLimiterMetricLine } from "./telemetry.ts";

export type RequestRateDecision =
  | { readonly kind: "admitted" }
  | { readonly kind: "rejected"; readonly retryAtUs: number };

export interface RequestRateStore {
  readonly consume: (
    organizationId: string,
    parameters: GcraParameters,
    nowUs: number,
  ) => Promise<RequestRateDecision>;
}

export class RequestRateStoreUnavailable extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RequestRateStoreUnavailable";
  }
}

export type RequestLimited = {
  readonly burst: number;
  readonly kind: "limited";
  readonly ratePerSecond: number;
  readonly retryAfterSeconds: number;
};

export type RequestAdmission = { readonly kind: "admitted" } | RequestLimited;

export interface OrganizationRequestLimiter {
  /** Charges one request against the organization's effective `limits`, which the caller read. */
  readonly admit: (organizationId: string, limits: TenantLimits) => Promise<RequestAdmission>;
}

export function chargedOrganization(
  organizationIds: readonly string[] | "*" | undefined,
): string | undefined {
  return organizationIds !== "*" && organizationIds?.length === 1 ? organizationIds[0] : undefined;
}

export function makeInMemoryRequestRateStore(): RequestRateStore {
  const arrivals = new Map<string, number>();
  return {
    consume: async (organizationId, parameters, nowUs) => {
      const decision = decideGcra(arrivals.get(organizationId), parameters, nowUs);
      if (decision.kind === "rejected") return decision;
      arrivals.set(organizationId, decision.theoreticalArrivalUs);
      return { kind: "admitted" };
    },
  };
}

const MAX_DENIED_ORGANIZATIONS = 10_000;

interface Denial {
  readonly limits: TenantLimits;
  readonly retryAtUs: number;
}

export function makeOrganizationRequestLimiter(input: {
  readonly now?: () => number;
  readonly service: string;
  readonly store: RequestRateStore;
  readonly writeMetric?: (line: string) => void;
}): OrganizationRequestLimiter {
  const now = input.now ?? Date.now;
  const writeMetric = input.writeMetric ?? ((line) => process.stdout.write(`${line}\n`));
  const denials = new Map<string, Denial>();

  const limited = (organizationId: string, denial: Denial, nowUs: number): RequestLimited => {
    const retryAfter = retryAfterSeconds(denial.retryAtUs, nowUs);
    writeMetric(
      requestLimiterMetricLine({
        metric: "ApiRequestsLimited",
        organizationId,
        properties: { retryAfterSeconds: retryAfter },
        service: input.service,
        timestamp: Math.floor(nowUs / 1000),
      }),
    );
    return {
      burst: denial.limits.apiRequestBurst,
      kind: "limited",
      ratePerSecond: denial.limits.apiRequestsPerSecond,
      retryAfterSeconds: retryAfter,
    };
  };

  return {
    admit: async (organizationId, limits) => {
      const nowUs = Math.round(now() * 1000);
      const remembered = denials.get(organizationId);
      if (remembered && remembered.retryAtUs > nowUs) {
        return limited(organizationId, remembered, nowUs);
      }
      denials.delete(organizationId);
      let decision: RequestRateDecision;
      try {
        decision = await input.store.consume(organizationId, gcraParameters(limits), nowUs);
      } catch (cause) {
        writeMetric(
          requestLimiterMetricLine({
            metric: "LimiterUnavailable",
            organizationId,
            properties: { errorType: cause instanceof Error ? cause.name : "UnknownError" },
            service: input.service,
            timestamp: Math.floor(nowUs / 1000),
          }),
        );
        return { kind: "admitted" };
      }
      if (decision.kind === "admitted") return decision;
      const denial = { limits, retryAtUs: decision.retryAtUs };
      denials.set(organizationId, denial);
      if (denials.size > MAX_DENIED_ORGANIZATIONS) {
        const oldest = denials.keys().next().value;
        if (oldest !== undefined) denials.delete(oldest);
      }
      return limited(organizationId, denial, nowUs);
    },
  };
}
