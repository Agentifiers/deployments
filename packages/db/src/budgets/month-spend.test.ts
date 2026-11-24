import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import type { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { ProjectRecord } from "../records/tenancy.ts";
import { ScopeSpendShardRecord, SpendMonth } from "../records/usage.ts";
import { makeTenancyTestDatabase } from "../tenancy-test-support.ts";
import { findExhaustedBudget } from "./admission.ts";
import {
  ORGANIZATION_ID,
  PROJECT_ID,
  RUN_SCOPE,
  budgetRecord,
  recordSpend,
  seed,
} from "./budget-test-support.ts";
import { readMonthSpend, readProjectMonthSpend, requestedSpendMonth } from "./month-spend.ts";
import { scopeSpendShardCandidates } from "./spend.ts";

describe("organization month spend", () => {
  test("splits month-to-date spend by who paid, across shards and scopes", async () => {
    const { database } = makeTenancyTestDatabase();
    await recordSpend(database, {
      occurredAt: "2026-01-03T10:00:00.000Z",
      shard: 2,
      spendUsdMicros: 600,
    });
    await recordSpend(database, {
      occurredAt: "2026-01-09T10:00:00.000Z",
      shard: 11,
      spendUsdMicros: 250,
    });
    await recordSpend(database, {
      funding: "organization",
      occurredAt: "2026-01-12T10:00:00.000Z",
      shard: 2,
      spendUsdMicros: 400,
    });
    await recordSpend(database, {
      occurredAt: "2026-02-01T00:00:00.000Z",
      shard: 2,
      spendUsdMicros: 9_000,
    });

    expect(
      await readMonthSpend(
        database,
        ORGANIZATION_ID,
        { scope: "organization" },
        new Date("2026-01-31T23:59:59.000Z"),
      ),
    ).toEqual({
      asOf: "2026-01-31T23:59:59.000Z",
      operatorFundedUsdMicros: 850,
      organizationFundedUsdMicros: 400,
      periodStart: "2026-01-01T00:00:00.000Z",
      totalUsdMicros: 1_250,
    });
  });

  test("reads a closed month as of a later instant", async () => {
    const { database } = makeTenancyTestDatabase();
    await recordSpend(database, {
      occurredAt: "2026-01-20T10:00:00.000Z",
      spendUsdMicros: 700,
    });
    await recordSpend(database, {
      funding: "organization",
      occurredAt: "2026-02-02T10:00:00.000Z",
      spendUsdMicros: 50,
    });

    expect(
      await readMonthSpend(
        database,
        ORGANIZATION_ID,
        { scope: "organization" },
        new Date("2026-02-03T00:00:00.000Z"),
        Schema.decodeUnknownSync(SpendMonth)("2026-01"),
      ),
    ).toEqual({
      asOf: "2026-02-03T00:00:00.000Z",
      operatorFundedUsdMicros: 700,
      organizationFundedUsdMicros: 0,
      periodStart: "2026-01-01T00:00:00.000Z",
      totalUsdMicros: 700,
    });
  });

  test("asks for the current UTC month by default and refuses malformed or future months", () => {
    const now = new Date("2026-03-31T23:30:00.000-02:00");
    const asked = (requested?: string): string | undefined =>
      Option.getOrUndefined(requestedSpendMonth(requested, now));

    expect([
      asked(),
      asked("2026-04"),
      asked("2025-12"),
      asked("2026-05"),
      asked("2026-4"),
      asked("2026-13"),
      asked("April"),
    ]).toEqual(["2026-04", "2026-04", "2025-12", undefined, undefined, undefined, undefined]);
  });

  test("reads spend on shards written before the split as operator-funded", async () => {
    const { database } = makeTenancyTestDatabase();
    const organizationMonthly = scopeSpendShardCandidates({
      occurredAt: "2026-01-03T10:00:00.000Z",
      scope: RUN_SCOPE,
      shard: 5,
      updatedAt: "2026-01-03T10:00:00.000Z",
    }).find((shard) => shard.data.scope === "organization" && shard.data.period === "monthly")!;
    const { organizationFundedUsdMicros: _split, ...legacyData } = organizationMonthly.data;
    await seed(database, [
      Schema.decodeUnknownSync(ScopeSpendShardRecord)({
        ...organizationMonthly,
        data: { ...legacyData, spendUsdMicros: 700 },
      }),
    ]);
    await recordSpend(database, {
      funding: "organization",
      occurredAt: "2026-01-04T10:00:00.000Z",
      shard: 5,
      spendUsdMicros: 300,
    });

    expect(
      await readMonthSpend(
        database,
        ORGANIZATION_ID,
        { scope: "organization" },
        new Date("2026-01-05T00:00:00.000Z"),
      ),
    ).toMatchObject({
      operatorFundedUsdMicros: 700,
      organizationFundedUsdMicros: 300,
      totalUsdMicros: 1_000,
    });
  });

  test("keeps customer budgets counting organization-funded spend", async () => {
    const { database } = makeTenancyTestDatabase();
    await seed(database, [budgetRecord({ amountUsdMicros: 1_000, scope: "organization" })]);
    await recordSpend(database, {
      funding: "organization",
      occurredAt: "2026-01-10T00:00:00.000Z",
      spendUsdMicros: 1_000,
    });

    expect(
      (await findExhaustedBudget(database, RUN_SCOPE, new Date("2026-01-20T00:00:00.000Z")))
        ?.spendUsdMicros,
    ).toBe(1_000);
  });

  test("rejects a shard whose organization-funded spend exceeds its total", () => {
    const [candidate] = scopeSpendShardCandidates({
      occurredAt: "2026-01-03T10:00:00.000Z",
      scope: RUN_SCOPE,
      shard: 0,
      updatedAt: "2026-01-03T10:00:00.000Z",
    });
    expect(() =>
      Schema.decodeUnknownSync(ScopeSpendShardRecord)({
        ...candidate,
        data: { ...candidate!.data, organizationFundedUsdMicros: 2, spendUsdMicros: 1 },
      }),
    ).toThrow("Organization-funded spend cannot exceed total spend.");
  });
});

describe("project month spend", () => {
  test("lists every project of the organization with its own month's spend", async () => {
    const { database } = makeTenancyTestDatabase();
    const OTHER_PROJECT_ID = "01J00000000000000000000PR2" as Ulid;
    const project = (id: Ulid, organizationId: Ulid) =>
      Schema.decodeUnknownSync(ProjectRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-01-01T00:00:00.000Z",
            id,
            name: id,
            organizationId,
            slug: id.toLowerCase(),
            status: "active",
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: 1,
          },
          itemType: "project" as const,
        }),
      );
    await seed(database, [
      project(PROJECT_ID, ORGANIZATION_ID),
      project(OTHER_PROJECT_ID, ORGANIZATION_ID),
      project("01J00000000000000000000PR3" as Ulid, "01J000000000000000000000R2" as Ulid),
    ]);
    await recordSpend(database, { occurredAt: "2026-01-03T10:00:00.000Z", spendUsdMicros: 600 });
    await recordSpend(database, {
      funding: "organization",
      occurredAt: "2026-01-04T10:00:00.000Z",
      scope: { ...RUN_SCOPE, projectId: OTHER_PROJECT_ID },
      spendUsdMicros: 40,
    });
    await recordSpend(database, { occurredAt: "2026-02-01T00:00:00.000Z", spendUsdMicros: 9 });

    expect(
      await readProjectMonthSpend(
        database,
        ORGANIZATION_ID,
        new Date("2026-02-03T00:00:00.000Z"),
        Schema.decodeUnknownSync(SpendMonth)("2026-01"),
      ),
    ).toEqual([
      {
        operatorFundedUsdMicros: 0,
        organizationFundedUsdMicros: 40,
        projectId: OTHER_PROJECT_ID,
        totalUsdMicros: 40,
      },
      {
        operatorFundedUsdMicros: 600,
        organizationFundedUsdMicros: 0,
        projectId: PROJECT_ID,
        totalUsdMicros: 600,
      },
    ]);
  });
});
