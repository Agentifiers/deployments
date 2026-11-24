import type { ModelGatewayRunLease, ModelGatewayRunLeaseReader } from "@deployments-ai/db";
import type { ModelGatewayRunTokenClaims } from "@deployments-ai/model-gateway";
import { makeExpiringLookup } from "./expiring-lookup.ts";

/** A run token stays usable at most this long after its run loses the thread lease. */
const RUN_ACTIVITY_CACHE_TTL_MS = 5_000;
const RUN_ACTIVITY_CACHE_MAX_ENTRIES = 10_000;

/** Raised when the lease cannot be read; the request fails and nothing is cached. */
export class RunStateUnavailableError extends Error {
  override readonly name = "RunStateUnavailableError";
}

type RunLeaseClaims = Pick<ModelGatewayRunTokenClaims, "leaseOwner" | "runId" | "threadId">;

export type RunActivityCheck = (claims: RunLeaseClaims) => Promise<boolean>;

/**
 * Whether a run token's run still holds its thread execution lease (same run, same owner, not
 * expired). Answers are cached for five seconds per (thread, run, owner), never past the lease's
 * own expiry; concurrent lookups for one key share a single read.
 */
export function makeRunActivityCheck(input: {
  readonly now: () => number;
  readonly reader: ModelGatewayRunLeaseReader;
}): RunActivityCheck {
  const lookup = makeExpiringLookup<boolean>({
    maxEntries: RUN_ACTIVITY_CACHE_MAX_ENTRIES,
    now: input.now,
  });

  const read = async (claims: RunLeaseClaims) => {
    let lease: ModelGatewayRunLease | undefined;
    try {
      lease = await input.reader.getThreadExecutionLease(claims.threadId);
    } catch (cause) {
      throw new RunStateUnavailableError("The run lease could not be read.", { cause });
    }
    const now = input.now();
    const leaseExpiresAt = lease ? Date.parse(lease.data.expiresAt) : Number.NaN;
    const active =
      lease !== undefined &&
      lease.data.runId === claims.runId &&
      lease.data.owner === claims.leaseOwner &&
      Number.isFinite(leaseExpiresAt) &&
      leaseExpiresAt > now;
    const validUntil = active
      ? Math.min(now + RUN_ACTIVITY_CACHE_TTL_MS, leaseExpiresAt)
      : now + RUN_ACTIVITY_CACHE_TTL_MS;
    return { validUntil, value: active };
  };

  return (claims) =>
    lookup(JSON.stringify([claims.threadId, claims.runId, claims.leaseOwner]), () => read(claims));
}
