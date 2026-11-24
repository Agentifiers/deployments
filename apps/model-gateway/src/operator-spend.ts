import type { OperatorModelSpend } from "@deployments-ai/model-gateway";
import { makeExpiringLookup } from "./expiring-lookup.ts";

/** An operator-funded call is admitted at most this long after recorded spend reaches the ceiling. */
const OPERATOR_SPEND_CACHE_TTL_MS = 5_000;
const OPERATOR_SPEND_CACHE_MAX_ENTRIES = 10_000;

/** Raised when spend or the ceiling cannot be read; the request fails and nothing is cached. */
export class OperatorSpendUnavailableError extends Error {
  override readonly name = "OperatorSpendUnavailableError";
}

export type OperatorSpendCheck = (organizationId: string) => Promise<OperatorModelSpend>;

/**
 * The organization's operator-funded model spend this UTC month against its ceiling, cached for
 * five seconds per organization; concurrent lookups for one organization share a single read.
 */
export function makeOperatorSpendCheck(input: {
  readonly now: () => number;
  readonly read: (organizationId: string, asOf: Date) => Promise<OperatorModelSpend>;
}): OperatorSpendCheck {
  const lookup = makeExpiringLookup<OperatorModelSpend>({
    maxEntries: OPERATOR_SPEND_CACHE_MAX_ENTRIES,
    now: input.now,
  });
  return (organizationId) =>
    lookup(organizationId, async () => {
      let spend: OperatorModelSpend;
      try {
        spend = await input.read(organizationId, new Date(input.now()));
      } catch (cause) {
        throw new OperatorSpendUnavailableError("Operator-funded spend could not be read.", {
          cause,
        });
      }
      return { validUntil: input.now() + OPERATOR_SPEND_CACHE_TTL_MS, value: spend };
    });
}
