import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { HoldKey, StandingActor } from "../records/organization-standing.ts";
import { OrganizationRecord } from "../records/tenancy.ts";
import type { DataBoundary } from "./data-boundary.ts";
import type { InstallDefaults } from "./effective-standing.ts";

export const ORGANIZATION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
export const OPERATOR = Schema.decodeUnknownSync(StandingActor)({
  kind: "operator",
  principalId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
});
export const BILLING = Schema.decodeUnknownSync(StandingActor)({
  kind: "service",
  service: "billing",
});
export const ABUSE_DESK = Schema.decodeUnknownSync(StandingActor)({
  kind: "service",
  service: "abuse-desk",
});
export const holdKey = Schema.decodeUnknownSync(HoldKey);

export const INSTALL_DEFAULTS: InstallDefaults = {
  operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
  tenantLimits: {
    activeSandboxes: 1,
    apiRequestBurst: 40,
    apiRequestsPerSecond: 20,
    concurrentRuns: 2,
  },
};

export function organizationRecord(organizationId: Ulid) {
  return Schema.decodeUnknownSync(OrganizationRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-01-01T00:00:00.000Z",
        id: organizationId,
        name: "Standing",
        slug: `standing-${organizationId.toLowerCase()}`,
        status: "active",
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
}

/** What an organization without a stored boundary may use: every egress class and provider. */
export const OPEN_BOUNDARY: DataBoundary = {
  egress: new Set(["platform", "configured", "public"]),
  modelProviders: new Set(["bedrock", "openai", "openrouter"]),
  profile: "open",
};

/** A clock that advances one minute per reading, so each write has its own timestamp. */
export function minuteClock() {
  let minute = 0;
  return () => new Date(Date.UTC(2026, 9, 1, 0, minute++));
}

/**
 * Holds the first `count` standing reads until all of them have read, so every writer starts from
 * the same version and all but one lose the conditional write.
 */
export function readersMeetBeforeWriting(count: number) {
  return (database: DynamoDatabaseService): DynamoDatabaseService => {
    const waiting: (() => void)[] = [];
    return {
      ...database,
      getRecord: async (table, recordKey, consistent) => {
        const record = await database.getRecord(table, recordKey, consistent);
        if (recordKey.sk === "ORGANIZATION-STANDING" && waiting.length < count) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === count) for (const release of waiting) release();
          });
        }
        return record;
      },
    };
  };
}
