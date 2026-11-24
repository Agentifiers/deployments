import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { RateLimitCounterRecord } from "../records/usage.ts";
import { transactionCanceledError } from "../testing/dynamo-document-client.fixture.ts";
import { harness } from "./domain-test-support.ts";
import { ORGANIZATION, OTHER_ORGANIZATION } from "./test-support.ts";

const decodeCounter = Schema.decodeUnknownSync(RateLimitCounterRecord);

const HOUR = 60 * 60 * 1_000;
const PLATFORM_COUNTER = "SCOPE#00000000000000000000000000";

function budgetWorld(limits: { readonly organization: number; readonly platform: number }) {
  let clock = Date.parse("2026-03-01T22:00:00.000Z");
  const context = harness({ now: () => new Date(clock) });
  const stored = () =>
    context.fake
      .items(context.tables.usage)
      .map((item) => decodeCounter(item))
      .sort((left, right) => left.pk.localeCompare(right.pk));
  return {
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    counters: () =>
      stored()
        .map(({ data, pk }) => `${pk} ${data.window} ${data.count} v${data.version}`)
        .sort(),
    fake: context.fake,
    stored,
    take: (organizationId = ORGANIZATION) =>
      context.apps.takeCertificateRequest({ limits, organizationId }),
  };
}

describe("certificate request budgets", () => {
  test("counts the UTC day and expires each counter at the next 00:00 UTC, whatever the local time zone", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const { advance, stored, take } = budgetWorld({ organization: 5, platform: 12 });
      advance(4 * HOUR);

      expect(await take()).toBe("granted");

      const nextMidnight = "2026-03-03T00:00:00.000Z";
      expect(
        stored().map(({ data, pk, ttl }) => ({
          expiresAt: data.expiresAt,
          organizationId: data.organizationId,
          pk,
          ttl,
          window: data.window,
        })),
      ).toEqual([
        {
          expiresAt: nextMidnight,
          organizationId: undefined,
          pk: PLATFORM_COUNTER,
          ttl: Date.parse(nextMidnight) / 1_000,
          window: "2026-03-02",
        },
        {
          expiresAt: nextMidnight,
          organizationId: ORGANIZATION,
          pk: `SCOPE#${ORGANIZATION}`,
          ttl: Date.parse(nextMidnight) / 1_000,
          window: "2026-03-02",
        },
      ]);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  test.each([PLATFORM_COUNTER, `SCOPE#${ORGANIZATION}`])(
    "writes both counters in one transaction, so a conflict on the %s put advances neither",
    async (conflicting) => {
      const { counters, fake, take } = budgetWorld({ organization: 5, platform: 12 });
      await take();
      fake.failNextTransaction(
        (input) =>
          input.TransactItems?.some((item) => item.Put?.Item?.["pk"] === conflicting) ?? false,
        () => transactionCanceledError(["ConditionalCheckFailed"]),
      );

      expect(await take()).toBe("granted");

      expect(counters()).toEqual([
        `${PLATFORM_COUNTER} 2026-03-01 2 v1`,
        `SCOPE#${ORGANIZATION} 2026-03-01 2 v1`,
      ]);
    },
  );

  test("refuses an organization past its daily limit while another organization still draws", async () => {
    const { counters, take } = budgetWorld({ organization: 2, platform: 12 });

    expect([await take(), await take(), await take(), await take(OTHER_ORGANIZATION)]).toEqual([
      "granted",
      "granted",
      "organization-spent",
      "granted",
    ]);
    expect(counters()).toEqual([
      "SCOPE#00000000000000000000000000 2026-03-01 3 v2",
      `SCOPE#${ORGANIZATION} 2026-03-01 2 v1`,
      `SCOPE#${OTHER_ORGANIZATION} 2026-03-01 1 v0`,
    ]);
  });

  test("shares one platform limit between every organization", async () => {
    const { take } = budgetWorld({ organization: 5, platform: 3 });

    expect([
      await take(),
      await take(OTHER_ORGANIZATION),
      await take(OTHER_ORGANIZATION),
      await take(),
      await take(OTHER_ORGANIZATION),
    ]).toEqual(["granted", "granted", "granted", "platform-spent", "platform-spent"]);
  });

  test("starts a fresh budget at 00:00 UTC", async () => {
    const { advance, counters, take } = budgetWorld({ organization: 1, platform: 12 });

    await take();
    advance(2 * HOUR - 1);
    expect(await take()).toBe("organization-spent");
    advance(1);
    expect(await take()).toBe("granted");
    expect(counters()).toEqual([
      "SCOPE#00000000000000000000000000 2026-03-01 1 v0",
      "SCOPE#00000000000000000000000000 2026-03-02 1 v0",
      `SCOPE#${ORGANIZATION} 2026-03-01 1 v0`,
      `SCOPE#${ORGANIZATION} 2026-03-02 1 v0`,
    ]);
  });

  test("lets only one of two concurrent takes spend the last unit", async () => {
    const { counters, take } = budgetWorld({ organization: 2, platform: 12 });
    await take();

    const results = await Promise.all([take(), take()]);

    expect(results.sort()).toEqual(["granted", "organization-spent"]);
    expect(counters()).toEqual([
      "SCOPE#00000000000000000000000000 2026-03-01 2 v1",
      `SCOPE#${ORGANIZATION} 2026-03-01 2 v1`,
    ]);
  });
});
