import type { TenantLimits } from "./limits.ts";

export interface GcraParameters {
  readonly burstToleranceUs: number;
  readonly emissionIntervalUs: number;
}

export type GcraDecision =
  | { readonly kind: "admitted"; readonly theoreticalArrivalUs: number }
  | { readonly kind: "rejected"; readonly retryAtUs: number };

export function gcraParameters(
  limits: Pick<TenantLimits, "apiRequestBurst" | "apiRequestsPerSecond">,
): GcraParameters {
  const emissionIntervalUs = Math.round(1e6 / limits.apiRequestsPerSecond);
  return {
    burstToleranceUs: (limits.apiRequestBurst - 1) * emissionIntervalUs,
    emissionIntervalUs,
  };
}

export function decideGcra(
  theoreticalArrivalUs: number | undefined,
  parameters: GcraParameters,
  nowUs: number,
): GcraDecision {
  const start = Math.max(theoreticalArrivalUs ?? nowUs, nowUs);
  if (start - nowUs > parameters.burstToleranceUs) {
    return { kind: "rejected", retryAtUs: start - parameters.burstToleranceUs };
  }
  return { kind: "admitted", theoreticalArrivalUs: start + parameters.emissionIntervalUs };
}

export function retryAfterSeconds(retryAtUs: number, nowUs: number) {
  return Math.max(1, Math.ceil((retryAtUs - nowUs) / 1e6));
}
