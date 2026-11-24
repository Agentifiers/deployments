import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { ORGANIZATION_ID, recordSpend, testId } from "../budgets/budget-test-support.ts";
import type { PlatformRecord } from "../records/index.ts";
import { SpendMonth } from "../records/usage.ts";
import { makeTenancyTestDatabase } from "../tenancy-test-support.ts";
import {
  readOperatorFundedModelSpend,
  recordOperatorFundedSpendExhaustion,
} from "./operator-funded-spend.ts";
import { makeOrganizationStandingRepository } from "./repository.ts";
import { INSTALL_DEFAULTS, OPERATOR, organizationRecord } from "./test-support.ts";

const JANUARY = Schema.decodeUnknownSync(SpendMonth)("2026-01");
const FEBRUARY = Schema.decodeUnknownSync(SpendMonth)("2026-02");
const CEILING = { monthlyUsdMicros: 1_000 };
const options = { generateId: testId, now: () => new Date("2026-02-10T00:00:00.000Z") };

function exhaustedEvents(records: ReadonlyMap<string, PlatformRecord>) {
  return [...records.values()].flatMap((record) =>
    record.itemType === "semantic-event" &&
    record.data.eventType === "organization.operator-funded-spend-exhausted"
      ? [record.data.payload]
      : [],
  );
}

describe("operator-funded spend exhaustion", () => {
  test("emits once when the month's operator-funded spend reaches the ceiling", async () => {
    const { database, records } = makeTenancyTestDatabase();
    const evaluate = (month = JANUARY) =>
      recordOperatorFundedSpendExhaustion(
        database,
        { ceiling: CEILING, month, organizationId: ORGANIZATION_ID },
        options,
      );

    await recordSpend(database, { occurredAt: "2026-01-04T00:00:00.000Z", spendUsdMicros: 600 });
    const below = await evaluate();
    await recordSpend(database, { occurredAt: "2026-01-05T00:00:00.000Z", spendUsdMicros: 400 });
    const reached = await evaluate();
    await recordSpend(database, { occurredAt: "2026-01-06T00:00:00.000Z", spendUsdMicros: 300 });
    const later = await evaluate();
    await recordSpend(database, { occurredAt: "2026-02-01T00:00:00.000Z", spendUsdMicros: 1_200 });
    const nextMonth = await evaluate(FEBRUARY);

    expect<unknown[]>([below, reached?.operatorFundedUsdMicros, later, nextMonth?.month]).toEqual([
      undefined,
      1_000,
      undefined,
      "2026-02",
    ]);
    expect(exhaustedEvents(records)).toEqual([
      {
        ceilingUsdMicros: 1_000,
        month: "2026-01",
        operatorFundedUsdMicros: 1_000,
        organizationId: ORGANIZATION_ID,
      },
      {
        ceilingUsdMicros: 1_000,
        month: "2026-02",
        operatorFundedUsdMicros: 1_200,
        organizationId: ORGANIZATION_ID,
      },
    ]);
  });

  test("emits once when evaluators race", async () => {
    const { database, records } = makeTenancyTestDatabase();
    await recordSpend(database, { occurredAt: "2026-01-04T00:00:00.000Z", spendUsdMicros: 1_500 });
    const input = { ceiling: CEILING, month: JANUARY, organizationId: ORGANIZATION_ID };

    const outcomes = await Promise.all([
      recordOperatorFundedSpendExhaustion(database, input, options),
      recordOperatorFundedSpendExhaustion(database, input, options),
      recordOperatorFundedSpendExhaustion(database, input, options),
    ]);

    expect(outcomes.filter((outcome) => outcome !== undefined)).toHaveLength(1);
    expect(exhaustedEvents(records)).toEqual([
      {
        ceilingUsdMicros: 1_000,
        month: "2026-01",
        operatorFundedUsdMicros: 1_500,
        organizationId: ORGANIZATION_ID,
      },
    ]);
  });

  test("counts only operator-funded spend and never fires for an unlimited ceiling", async () => {
    const { database, records } = makeTenancyTestDatabase();
    await recordSpend(database, {
      funding: "organization",
      occurredAt: "2026-01-04T00:00:00.000Z",
      spendUsdMicros: 5_000,
    });
    await recordSpend(database, { occurredAt: "2026-01-05T00:00:00.000Z", spendUsdMicros: 999 });

    const finite = await recordOperatorFundedSpendExhaustion(
      database,
      { ceiling: CEILING, month: JANUARY, organizationId: ORGANIZATION_ID },
      options,
    );
    const unlimited = await recordOperatorFundedSpendExhaustion(
      database,
      { ceiling: "unlimited", month: JANUARY, organizationId: ORGANIZATION_ID },
      options,
    );
    await recordSpend(database, { occurredAt: "2026-01-06T00:00:00.000Z", spendUsdMicros: 1 });
    const reached = await recordOperatorFundedSpendExhaustion(
      database,
      { ceiling: CEILING, month: JANUARY, organizationId: ORGANIZATION_ID },
      options,
    );

    expect([finite, unlimited, reached?.operatorFundedUsdMicros]).toEqual([
      undefined,
      undefined,
      1_000,
    ]);
    expect(exhaustedEvents(records)).toHaveLength(1);
  });
});

describe("operator-funded model spend", () => {
  const asOf = new Date("2026-01-20T00:00:00.000Z");

  test("reports this month's operator-funded spend against the operator grant's ceiling", async () => {
    const { database } = makeTenancyTestDatabase();
    await database.putRecord(organizationRecord(ORGANIZATION_ID));
    await makeOrganizationStandingRepository({
      database,
      installDefaults: INSTALL_DEFAULTS,
    }).setGrant({
      actor: OPERATOR,
      entitlements: { operatorFundedModelSpendCeiling: { monthlyUsdMicros: 2_000 } },
      organizationId: ORGANIZATION_ID,
    });
    await recordSpend(database, { occurredAt: "2025-12-31T00:00:00.000Z", spendUsdMicros: 900 });
    await recordSpend(database, { occurredAt: "2026-01-04T00:00:00.000Z", spendUsdMicros: 1_500 });
    await recordSpend(database, {
      funding: "organization",
      occurredAt: "2026-01-05T00:00:00.000Z",
      spendUsdMicros: 700,
    });

    expect(
      await readOperatorFundedModelSpend(database, ORGANIZATION_ID, {
        asOf,
        defaultCeiling: CEILING,
      }),
    ).toEqual({ ceilingUsdMicros: 2_000, kind: "metered", spentUsdMicros: 1_500 });
  });

  test("falls back to the install default and skips the spend read when it is unlimited", async () => {
    const { database } = makeTenancyTestDatabase();
    const queried: string[] = [];
    const counted: typeof database = {
      ...database,
      queryRecords: (table, input) => {
        queried.push(table);
        return database.queryRecords(table, input);
      },
    };
    await recordSpend(database, { occurredAt: "2026-01-04T00:00:00.000Z", spendUsdMicros: 1_000 });

    expect(
      await readOperatorFundedModelSpend(counted, ORGANIZATION_ID, {
        asOf,
        defaultCeiling: CEILING,
      }),
    ).toEqual({ ceilingUsdMicros: 1_000, kind: "metered", spentUsdMicros: 1_000 });
    expect(
      await readOperatorFundedModelSpend(counted, ORGANIZATION_ID, {
        asOf,
        defaultCeiling: "unlimited",
      }),
    ).toEqual({ kind: "unlimited" });
    expect(queried).toEqual(["usage"]);
  });

  test("rejects an organization id that is not a ULID", async () => {
    const { database } = makeTenancyTestDatabase();

    expect(
      readOperatorFundedModelSpend(database, "org-1", { asOf, defaultCeiling: CEILING }),
    ).rejects.toThrow("Expected a 26-character ULID.");
  });
});
