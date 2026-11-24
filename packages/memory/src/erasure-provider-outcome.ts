import { Timestamp } from "@deployments-ai/db";
import { Schema } from "effect";

export interface PurgeBoundary {
  readonly backupErasureEligibleAt: string;
  readonly providerPurgeStartedAt: string;
}

export type TenantPurgeOutcome =
  | {
      readonly boundary: PurgeBoundary;
      readonly kind: "live-purge-running";
      readonly receipt: Readonly<Record<string, unknown>>;
    }
  | {
      readonly boundary: PurgeBoundary | undefined;
      readonly kind: "live-purge-verified";
      readonly receipt: Readonly<Record<string, unknown>>;
    };

const ProviderPurgeReceipt = Schema.Union([
  Schema.Struct({
    absenceVerified: Schema.Literal(true),
    backupErasureEligibleAt: Schema.optional(Timestamp),
    providerPurgeStartedAt: Schema.optional(Timestamp),
  }),
  Schema.Struct({
    absenceVerified: Schema.Literal(false),
    backupErasureEligibleAt: Timestamp,
    liveStorageVerified: Schema.Literal(true),
    providerPurgeStartedAt: Timestamp,
    providerPurgeState: Schema.Struct({
      liveStorageVerifiedAt: Timestamp,
      openSearchIndexAbsent: Schema.optional(Schema.Boolean),
      stage: Schema.Literal("backup-wait"),
    }),
  }),
  Schema.Struct({
    absenceVerified: Schema.Literal(false),
    backupErasureEligibleAt: Timestamp,
    liveStorageVerified: Schema.optional(Schema.Literal(false)),
    providerPurgeStartedAt: Timestamp,
  }),
]);

export function parseTenantPurgeOutcome(
  providerId: string,
  receipt: Readonly<Record<string, unknown>>,
): TenantPurgeOutcome {
  let parsed: typeof ProviderPurgeReceipt.Type;
  try {
    parsed = Schema.decodeUnknownSync(ProviderPurgeReceipt)(receipt);
  } catch (cause) {
    throw new Error(`${providerId} returned an invalid organization purge receipt.`, { cause });
  }
  if (parsed.absenceVerified) {
    const { backupErasureEligibleAt, providerPurgeStartedAt } = parsed;
    if ((backupErasureEligibleAt === undefined) !== (providerPurgeStartedAt === undefined)) {
      throw new Error(`${providerId} returned a partial organization purge boundary.`);
    }
    return {
      boundary:
        backupErasureEligibleAt && providerPurgeStartedAt
          ? { backupErasureEligibleAt, providerPurgeStartedAt }
          : undefined,
      kind: "live-purge-verified",
      receipt,
    };
  }
  const boundary = {
    backupErasureEligibleAt: parsed.backupErasureEligibleAt,
    providerPurgeStartedAt: parsed.providerPurgeStartedAt,
  };
  return parsed.liveStorageVerified
    ? { boundary, kind: "live-purge-verified", receipt }
    : { boundary, kind: "live-purge-running", receipt };
}

export function requireBoundaryContinuity(
  checkpoint: PurgeBoundary | undefined,
  outcome: TenantPurgeOutcome,
) {
  if (!checkpoint) return;
  const next = outcome.boundary;
  if (!next) throw new Error("Provider purge retry returned no erasure boundary.");
  const previousEligibleAt = Date.parse(checkpoint.backupErasureEligibleAt);
  const nextEligibleAt = Date.parse(next.backupErasureEligibleAt);
  const purgeRestarted = next.providerPurgeStartedAt !== checkpoint.providerPurgeStartedAt;
  const boundaryMovedEarlier = nextEligibleAt < previousEligibleAt;
  const boundaryMovedLaterWithoutVerification =
    nextEligibleAt > previousEligibleAt && outcome.kind === "live-purge-running";
  if (purgeRestarted || boundaryMovedEarlier || boundaryMovedLaterWithoutVerification) {
    throw new Error("Provider purge retry returned an invalid erasure boundary.");
  }
}
