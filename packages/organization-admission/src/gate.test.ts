import type { DynamoDatabaseService } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { admitConsistently } from "./gate.ts";
import { standingInstallation } from "./test-support.ts";

function failingStandingReads(failing: { now: boolean }) {
  return (database: DynamoDatabaseService): DynamoDatabaseService => ({
    ...database,
    getRecord: async (table, recordKey, consistent) => {
      if (failing.now && recordKey.sk === "ORGANIZATION-STANDING") {
        throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceeded" });
      }
      return database.getRecord(table, recordKey, consistent);
    },
  });
}

function countingReads(reads: { count: number }) {
  return (database: DynamoDatabaseService): DynamoDatabaseService => ({
    ...database,
    getRecord: (...args) => {
      reads.count += 1;
      return database.getRecord(...args);
    },
    queryRecords: (...args) => {
      reads.count += 1;
      return database.queryRecords(...args);
    },
  });
}

describe("organization gate", () => {
  test("a hold placed after a cached read takes effect once the five-second cache expires", async () => {
    const { advance, gate, organizationId, placeHold } = standingInstallation();

    const before = await gate.admit(organizationId, "api.write");
    await placeHold("payment");
    advance(4_999);
    const cached = await gate.admit(organizationId, "api.write");
    advance(1);
    const expired = await gate.admit(organizationId, "api.write");

    expect([before.kind, cached.kind, expired.kind]).toEqual(["admitted", "admitted", "suspended"]);
  });

  test("a suspended organization still reads and remediates, and is rate limited while it does", async () => {
    const { gate, grant, organizationId, placeHold } = standingInstallation();
    await grant("operator", { tenantLimits: { apiRequestBurst: 2, apiRequestsPerSecond: 1 } });
    await placeHold("abuse");

    const decisions = [
      await gate.admit(organizationId, "api.write"),
      await gate.admit(organizationId, "api.read"),
      await gate.admit(organizationId, "api.remediate"),
      await gate.admit(organizationId, "api.read"),
    ];

    expect(decisions.map((decision) => decision.kind)).toEqual([
      "suspended",
      "admitted",
      "admitted",
      "limited",
    ]);
  });

  test("a failed standing read admits on the last standing it saw and emits a metric", async () => {
    const failing = { now: false };
    const { advance, gate, metrics, organizationId, placeHold } = standingInstallation({
      wrap: failingStandingReads(failing),
    });
    await placeHold("policy");

    const suspended = await gate.admit(organizationId, "api.write");
    failing.now = true;
    advance(10_000);
    const stale = await gate.admit(organizationId, "api.write");

    expect([suspended.kind, stale.kind]).toEqual(["suspended", "suspended"]);
    expect(metrics).toEqual([
      {
        _aws: {
          CloudWatchMetrics: [
            {
              Dimensions: [["Service"], []],
              Metrics: [{ Name: "StandingUnavailable", Unit: "Count" }],
              Namespace: "DeploymentsAi/OrganizationAdmission",
            },
          ],
          Timestamp: Date.UTC(2026, 9, 1) + 10_000,
        },
        Service: "test-api",
        StandingUnavailable: 1,
        errorType: "ProvisionedThroughputExceeded",
        organizationId,
      },
    ]);
  });

  test("a failed standing read with nothing cached admits the request", async () => {
    const failing = { now: false };
    const { gate, metrics, organizationId, placeHold } = standingInstallation({
      wrap: failingStandingReads(failing),
    });
    await placeHold("policy");
    failing.now = true;

    const decision = await gate.admit(organizationId, "api.write");

    expect([decision.kind, metrics.length]).toEqual(["admitted", 1]);
  });

  test("the consistent read sees a hold at once and fails closed when the read fails", async () => {
    const failing = { now: false };
    const { gate, organizationId, placeHold, repository } = standingInstallation({
      wrap: failingStandingReads(failing),
    });
    await gate.admit(organizationId, "api.read");
    await placeHold("payment");

    const cached = await gate.admit(organizationId, "api.write");
    const consistent = await admitConsistently({
      activity: "run.admit",
      organizationId,
      standing: repository,
    });
    failing.now = true;
    const failure = await admitConsistently({
      activity: "run.admit",
      organizationId,
      standing: repository,
    }).catch((cause: unknown) => (cause instanceof Error ? cause.message : "unknown"));

    expect([cached.kind, consistent.decision.kind, consistent.standing.version, failure]).toEqual([
      "admitted",
      "suspended",
      1,
      "throttled",
    ]);
  });
});

describe("organization gate request limits", () => {
  test("enforces the install defaults when no grant sets a limit", async () => {
    const { gate, organizationId } = standingInstallation();

    const decisions = [];
    for (let request = 0; request < 41; request += 1) {
      decisions.push(await gate.admit(organizationId, "api.read"));
    }

    expect(decisions.filter((decision) => decision.kind === "admitted")).toHaveLength(40);
    expect(decisions.at(-1)).toEqual({
      burst: 40,
      kind: "limited",
      ratePerSecond: 20,
      retryAfterSeconds: 1,
    });
  });

  test("enforces the service grant, with the operator grant's fields over it", async () => {
    const { advance, gate, grant, organizationId } = standingInstallation();
    await grant("service", { tenantLimits: { apiRequestBurst: 1, apiRequestsPerSecond: 1 } });

    const serviceOnly = [
      await gate.admit(organizationId, "api.read"),
      await gate.admit(organizationId, "api.read"),
    ];
    await grant("operator", { tenantLimits: { apiRequestBurst: 3 } });
    advance(5_000);
    const withOperator = [];
    for (let request = 0; request < 4; request += 1) {
      withOperator.push(await gate.admit(organizationId, "api.read"));
    }

    expect(serviceOnly).toEqual([
      { kind: "admitted" },
      { burst: 1, kind: "limited", ratePerSecond: 1, retryAfterSeconds: 1 },
    ]);
    expect(withOperator).toEqual([
      { kind: "admitted" },
      { kind: "admitted" },
      { kind: "admitted" },
      { burst: 3, kind: "limited", ratePerSecond: 1, retryAfterSeconds: 1 },
    ]);
  });

  test("reads standing once per uncached request and nothing more for its limits", async () => {
    const reads = { count: 0 };
    const { advance, gate, grant, organizationId } = standingInstallation({
      wrap: countingReads(reads),
    });
    await grant("service", { tenantLimits: { concurrentRuns: 16 } });
    reads.count = 0;

    await gate.admit(organizationId, "api.write");
    const afterFirst = reads.count;
    await gate.admit(organizationId, "api.write");
    const afterCached = reads.count;
    advance(5_000);
    await gate.admit(organizationId, "api.write");

    expect([afterFirst, afterCached, reads.count]).toEqual([1, 1, 2]);
  });
});
