import {
  HoldKey,
  makeOrganizationStandingRepository,
  OrganizationRecord,
  StandingActor,
  Ulid,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type EntitlementGrant,
  type HoldReason,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import {
  makeInMemoryRequestRateStore,
  makeOrganizationRequestLimiter,
  type OrganizationRequestLimiter,
  type TenantLimits,
} from "@deployments-ai/tenant-limits";
import { Schema } from "effect";
import { createOrganizationGate } from "./gate.ts";

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const OPERATOR = Schema.decodeUnknownSync(StandingActor)({
  kind: "operator",
  principalId: "01J9ZQ5Y5V7Q8R3X2K4M6N8P0B",
});
const BILLING = Schema.decodeUnknownSync(StandingActor)({ kind: "service", service: "billing" });

const INSTALL_DEFAULTS = {
  operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
  tenantLimits: {
    activeSandboxes: 1,
    apiRequestBurst: 40,
    apiRequestsPerSecond: 20,
    concurrentRuns: 2,
  },
};

/** Places and releases an operator's holds on an organization in a test database. */
export function organizationHolds(database: DynamoDatabaseService, organizationId: string) {
  const repository = makeOrganizationStandingRepository({
    database,
    installDefaults: INSTALL_DEFAULTS,
  });
  const scope = (reason: HoldReason) => ({
    actor: OPERATOR,
    key: Schema.decodeUnknownSync(HoldKey)(`${reason}-review`),
    organizationId: decodeUlid(organizationId),
  });
  return {
    hold: (reason: HoldReason) =>
      repository.placeHold({
        ...scope(reason),
        customerMessage: "Update your payment method.",
        reason,
      }),
    release: (reason: HoldReason) => repository.releaseHold(scope(reason)),
  };
}

/**
 * An installation with one organization whose standing is real repository state, and a gate over
 * it whose clock the test moves. `defaultLimits` replaces install default tenant limits.
 */
export function standingInstallation(
  input: {
    readonly defaultLimits?: Partial<TenantLimits>;
    readonly organizationId?: string;
    readonly limiter?: OrganizationRequestLimiter;
    readonly wrap?: (database: DynamoDatabaseService) => DynamoDatabaseService;
  } = {},
) {
  const installDefaults = {
    ...INSTALL_DEFAULTS,
    tenantLimits: { ...INSTALL_DEFAULTS.tenantLimits, ...input.defaultLimits },
  };
  const organizationId = decodeUlid(input.organizationId ?? "01J9ZQ5Y5V7Q8R3X2K4M6N8P0A");
  const memory = evaluationMemoryDatabase([
    Schema.decodeUnknownSync(OrganizationRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-01-01T00:00:00.000Z",
          id: organizationId,
          name: "Acme",
          slug: "acme",
          status: "active",
          updatedAt: "2026-01-01T00:00:00.000Z",
          version: 1,
        },
        itemType: "organization" as const,
      }),
    ),
  ]);
  let wallClock = Date.UTC(2026, 9, 1);
  const repository = makeOrganizationStandingRepository({
    database: (input.wrap ?? ((database) => database))(memory.database),
    installDefaults,
    now: () => new Date(wallClock),
  });
  const metrics: unknown[] = [];
  const gate = createOrganizationGate({
    defaultLimits: installDefaults.tenantLimits,
    limiter:
      input.limiter ??
      makeOrganizationRequestLimiter({
        now: () => wallClock,
        service: "test-api",
        store: makeInMemoryRequestRateStore(),
        writeMetric: () => {},
      }),
    now: () => wallClock,
    service: "test-api",
    standing: repository,
    writeMetric: (line) => metrics.push(JSON.parse(line)),
  });
  return {
    advance: (milliseconds: number) => {
      wallClock += milliseconds;
    },
    gate,
    grant: (source: "operator" | "service", entitlements: EntitlementGrant) =>
      repository.setGrant({
        actor: source === "operator" ? OPERATOR : BILLING,
        entitlements,
        organizationId,
      }),
    metrics,
    organizationId,
    placeHold: (reason: HoldReason, customerMessage = "Update your payment method.") =>
      repository.placeHold({
        actor: OPERATOR,
        customerMessage,
        key: Schema.decodeUnknownSync(HoldKey)(`${reason}-review`),
        operatorNote: "ticket 4411",
        organizationId,
        reason,
      }),
    releaseHold: (reason: HoldReason) =>
      repository.releaseHold({
        actor: OPERATOR,
        key: Schema.decodeUnknownSync(HoldKey)(`${reason}-review`),
        organizationId,
      }),
    repository,
  };
}
