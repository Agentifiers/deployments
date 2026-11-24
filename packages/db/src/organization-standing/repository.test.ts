import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import { Ulid } from "../ids.ts";
import { ALL_FEATURES_ENABLED } from "./effective-standing.ts";
import { makeOrganizationStandingRepository } from "./repository.ts";
import {
  ABUSE_DESK,
  BILLING,
  INSTALL_DEFAULTS,
  OPEN_BOUNDARY,
  OPERATOR,
  ORGANIZATION_ID,
  holdKey,
  minuteClock,
  organizationRecord,
  readersMeetBeforeWriting,
} from "./test-support.ts";

const DEFAULT_ENTITLEMENTS = { ...INSTALL_DEFAULTS, features: ALL_FEATURES_ENABLED };

const TOS_REVIEW = holdKey("tos-review");
const PAYMENT_OVERDUE = holdKey("payment-overdue");

function harness(wrap: (database: DynamoDatabaseService) => DynamoDatabaseService = (d) => d) {
  const memory = evaluationMemoryDatabase([organizationRecord(ORGANIZATION_ID)]);
  const standing = makeOrganizationStandingRepository({
    database: wrap(memory.database),
    installDefaults: INSTALL_DEFAULTS,
    now: minuteClock(),
  });
  const events = () =>
    memory
      .all()
      .flatMap((record) =>
        record.itemType === "semantic-event"
          ? [
              [
                record.data.eventType,
                record.data.aggregateType,
                record.data.aggregateVersion,
                record.data.payload,
              ] as const,
            ]
          : [],
      );
  const stored = () =>
    memory
      .all()
      .flatMap((record) =>
        record.itemType === "organization-standing" ||
        record.itemType === "organization-standing-change"
          ? [[record.pk, record.sk] as const]
          : [],
      );
  return { events, memory, standing, stored };
}

const operatorHold = {
  actor: OPERATOR,
  customerMessage: "Your organization is under review.",
  key: TOS_REVIEW,
  operatorNote: "ticket 4411",
  organizationId: ORGANIZATION_ID,
  reason: "abuse" as const,
};
const billingHold = {
  actor: BILLING,
  customerMessage: "An invoice is overdue.",
  key: PAYMENT_OVERDUE,
  organizationId: ORGANIZATION_ID,
  reason: "payment" as const,
};

describe("organization standing holds", () => {
  test("placing or releasing the same hold twice writes and emits once", async () => {
    const { events, memory, standing } = harness();

    const placed = await standing.placeHold(operatorHold);
    const placedAgain = await standing.placeHold({ ...operatorHold, reason: "policy" });
    const released = await standing.releaseHold({
      actor: OPERATOR,
      key: TOS_REVIEW,
      organizationId: ORGANIZATION_ID,
      releaseNote: "cleared",
    });
    const releasedAgain = await standing.releaseHold({
      actor: OPERATOR,
      key: TOS_REVIEW,
      organizationId: ORGANIZATION_ID,
    });

    expect<unknown>(placed).toEqual({
      kind: "changed",
      standing: {
        dataBoundary: OPEN_BOUNDARY,
        entitlements: DEFAULT_ENTITLEMENTS,
        holds: [
          {
            customerMessage: "Your organization is under review.",
            key: "tos-review",
            operatorNote: "ticket 4411",
            placedAt: "2026-10-01T00:00:00.000Z",
            placedBy: { kind: "operator", principalId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" },
            reason: "abuse",
            source: "operator",
          },
        ],
        state: "suspended",
        suspendedAt: "2026-10-01T00:00:00.000Z",
        version: 1,
      },
    });
    expect(placedAgain.kind).toBe("unchanged");
    expect(placedAgain.standing).toEqual(placed.standing);
    expect(released).toEqual({
      kind: "changed",
      standing: {
        dataBoundary: OPEN_BOUNDARY,
        entitlements: DEFAULT_ENTITLEMENTS,
        state: "active",
        version: 2,
      },
    });
    expect(releasedAgain).toEqual({
      kind: "unchanged",
      standing: {
        dataBoundary: OPEN_BOUNDARY,
        entitlements: DEFAULT_ENTITLEMENTS,
        state: "active",
        version: 2,
      },
    });
    expect(memory.transactions).toHaveLength(2);
    expect(events()).toEqual([
      [
        "organization.hold-placed",
        "organization-standing",
        1,
        {
          customerMessage: "Your organization is under review.",
          key: "tos-review",
          reason: "abuse",
          source: "operator",
        },
      ],
      [
        "organization.suspended",
        "organization-suspension",
        1,
        { reasons: ["abuse"], since: "2026-10-01T00:00:00.000Z" },
      ],
      [
        "organization.hold-released",
        "organization-standing",
        2,
        { key: "tos-review", reason: "abuse", source: "operator" },
      ],
      [
        "organization.reinstated",
        "organization-suspension",
        2,
        { since: "2026-10-01T00:00:00.000Z" },
      ],
    ]);
  });

  test("releases a hold whose standing and suspension events retention deleted", async () => {
    const { events, memory, standing } = harness();
    await standing.placeHold(operatorHold);
    for (const [itemKey, record] of memory.records) {
      if (record.itemType === "semantic-event") memory.records.delete(itemKey);
    }

    const released = await standing.releaseHold({
      actor: OPERATOR,
      key: TOS_REVIEW,
      organizationId: ORGANIZATION_ID,
    });

    expect(released.kind).toBe("changed");
    expect(
      events().map(([eventType, aggregateType, version]) => [eventType, aggregateType, version]),
    ).toEqual([
      ["organization.hold-released", "organization-standing", 2],
      ["organization.reinstated", "organization-suspension", 2],
    ]);
  });

  test("refuses to release a hold another source placed", async () => {
    const { memory, standing } = harness();
    await standing.placeHold(operatorHold);

    const refused = await standing.releaseHold({
      actor: BILLING,
      key: TOS_REVIEW,
      organizationId: ORGANIZATION_ID,
    });

    expect(refused.kind).toBe("refused");
    expect<unknown>(refused.kind === "refused" && refused.owner).toBe("operator");
    expect(refused.standing.state).toBe("suspended");
    expect(memory.transactions).toHaveLength(1);
  });

  test("emits suspended and reinstated only when the hold set crosses empty", async () => {
    const { events, standing } = harness();
    const release = (actor: typeof OPERATOR, key: typeof TOS_REVIEW) =>
      standing.releaseHold({ actor, key, organizationId: ORGANIZATION_ID });

    await standing.placeHold(operatorHold);
    await standing.placeHold(billingHold);
    await release(OPERATOR, TOS_REVIEW);
    const stillHeld = await standing.read(ORGANIZATION_ID, { consistent: true });
    await release(BILLING, PAYMENT_OVERDUE);
    await standing.placeHold(billingHold);

    expect<unknown>(
      stillHeld.state === "suspended" && stillHeld.holds.map((hold) => hold.source),
    ).toEqual(["service:billing"]);
    expect(
      events().map(([eventType, aggregateType, version]) => [eventType, aggregateType, version]),
    ).toEqual([
      ["organization.hold-placed", "organization-standing", 1],
      ["organization.suspended", "organization-suspension", 1],
      ["organization.hold-placed", "organization-standing", 2],
      ["organization.hold-released", "organization-standing", 3],
      ["organization.hold-released", "organization-standing", 4],
      ["organization.reinstated", "organization-suspension", 2],
      ["organization.hold-placed", "organization-standing", 5],
      ["organization.suspended", "organization-suspension", 1],
    ]);
  });

  test("lands holds two sources place at the same time", async () => {
    const meet = readersMeetBeforeWriting(2);
    const { events, standing } = harness(meet);

    const outcomes = await Promise.all([
      standing.placeHold(operatorHold),
      standing.placeHold(billingHold),
    ]);
    const final = await standing.read(ORGANIZATION_ID, { consistent: true });

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["changed", "changed"]);
    expect(final.version).toBe(2);
    expect<unknown>(
      final.state === "suspended" && final.holds.map((hold) => hold.source).toSorted(),
    ).toEqual(["operator", "service:billing"]);
    expect(
      events()
        .map(([eventType]) => eventType)
        .toSorted(),
    ).toEqual(["organization.hold-placed", "organization.hold-placed", "organization.suspended"]);
  });

  test("reports a hold on an organization that does not exist as not found", async () => {
    const { standing } = harness();
    const missing = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");

    expect(
      standing.releaseHold({ actor: OPERATOR, key: TOS_REVIEW, organizationId: missing }),
    ).rejects.toMatchObject({ code: "organization_not_found", kind: "not-found" });
  });

  test("stores one standing item and one change per version under the organization", async () => {
    const { standing, stored } = harness();
    await standing.placeHold(operatorHold);
    await standing.setGrant({
      actor: OPERATOR,
      entitlements: { tenantLimits: { concurrentRuns: 64 } },
      organizationId: ORGANIZATION_ID,
    });

    expect(stored().toSorted(([, left], [, right]) => left.localeCompare(right))).toEqual([
      ["ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV", "ORGANIZATION-STANDING"],
      ["ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV", "ORGANIZATION-STANDING-CHANGE#0000000000000001"],
      ["ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV", "ORGANIZATION-STANDING-CHANGE#0000000000000002"],
    ]);
  });
});

describe("organization standing grants", () => {
  test("merges the operator grant over the service grant over install defaults", async () => {
    const { events, standing } = harness();

    await standing.setGrant({
      actor: BILLING,
      entitlements: {
        operatorFundedModelSpendCeiling: { monthlyUsdMicros: 100_000_000 },
        tenantLimits: { activeSandboxes: 4, concurrentRuns: 16 },
      },
      organizationId: ORGANIZATION_ID,
    });
    const operatorGrant = await standing.setGrant({
      actor: OPERATOR,
      entitlements: { tenantLimits: { concurrentRuns: 64 } },
      organizationId: ORGANIZATION_ID,
    });
    const sameGrant = await standing.setGrant({
      actor: OPERATOR,
      entitlements: { tenantLimits: { concurrentRuns: 64 } },
      organizationId: ORGANIZATION_ID,
    });
    const operatorCleared = await standing.clearGrant({
      actor: OPERATOR,
      organizationId: ORGANIZATION_ID,
    });

    expect(operatorGrant).toEqual({
      kind: "changed",
      standing: {
        dataBoundary: OPEN_BOUNDARY,
        entitlements: {
          features: ALL_FEATURES_ENABLED,
          operatorFundedModelSpendCeiling: { monthlyUsdMicros: 100_000_000 },
          tenantLimits: {
            activeSandboxes: 4,
            apiRequestBurst: 40,
            apiRequestsPerSecond: 20,
            concurrentRuns: 64,
          },
        },
        state: "active",
        version: 2,
      },
    });
    expect(sameGrant.kind).toBe("unchanged");
    expect(operatorCleared.standing.entitlements.tenantLimits.concurrentRuns).toBe(16);
    expect(
      events().map(([eventType, , version, payload]) => [eventType, version, payload]),
    ).toEqual([
      ["organization.entitlements-updated", 1, { granted: true, source: "service:billing" }],
      ["organization.entitlements-updated", 2, { granted: true, source: "operator" }],
      ["organization.entitlements-updated", 3, { granted: false, source: "operator" }],
    ]);
  });

  test("refuses a service grant change while another service owns the service grant", async () => {
    const { standing } = harness();
    await standing.setGrant({
      actor: BILLING,
      entitlements: { operatorFundedModelSpendCeiling: "unlimited" },
      organizationId: ORGANIZATION_ID,
    });

    const refusedSet = await standing.setGrant({
      actor: ABUSE_DESK,
      entitlements: { tenantLimits: { concurrentRuns: 1 } },
      organizationId: ORGANIZATION_ID,
    });
    const refusedClear = await standing.clearGrant({
      actor: ABUSE_DESK,
      organizationId: ORGANIZATION_ID,
    });

    expect<unknown>(
      [refusedSet, refusedClear].map((outcome) => outcome.kind === "refused" && outcome.owner),
    ).toEqual(["service:billing", "service:billing"]);
    expect(refusedClear.standing.entitlements.operatorFundedModelSpendCeiling).toBe("unlimited");
  });

  test("reads each source's stored grant beside the effective standing", async () => {
    const { standing } = harness();
    const before = await standing.readWithGrants(ORGANIZATION_ID);
    await standing.setGrant({
      actor: BILLING,
      entitlements: { operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 } },
      organizationId: ORGANIZATION_ID,
    });
    await standing.setGrant({
      actor: OPERATOR,
      entitlements: { tenantLimits: { concurrentRuns: 64 } },
      organizationId: ORGANIZATION_ID,
    });

    expect(before).toEqual({
      dataBoundary: undefined,
      grants: {},
      standing: {
        dataBoundary: OPEN_BOUNDARY,
        entitlements: DEFAULT_ENTITLEMENTS,
        state: "active",
        version: 0,
      },
    });
    expect<unknown>(await standing.readWithGrants(ORGANIZATION_ID, { consistent: true })).toEqual({
      grants: {
        operator: {
          entitlements: { tenantLimits: { concurrentRuns: 64 } },
          grantedAt: "2026-10-01T00:01:00.000Z",
          grantedBy: OPERATOR,
        },
        service: {
          entitlements: { operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 } },
          grantedAt: "2026-10-01T00:00:00.000Z",
          grantedBy: BILLING,
        },
      },
      standing: {
        dataBoundary: OPEN_BOUNDARY,
        entitlements: {
          features: ALL_FEATURES_ENABLED,
          operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
          tenantLimits: { ...INSTALL_DEFAULTS.tenantLimits, concurrentRuns: 64 },
        },
        state: "active",
        version: 2,
      },
    });
  });
});

describe("organization standing history", () => {
  test("lists changes newest first in pages", async () => {
    const { standing } = harness();
    await standing.placeHold(operatorHold);
    await standing.setGrant({
      actor: BILLING,
      entitlements: { operatorFundedModelSpendCeiling: "unlimited" },
      organizationId: ORGANIZATION_ID,
    });
    await standing.releaseHold({
      actor: OPERATOR,
      key: TOS_REVIEW,
      organizationId: ORGANIZATION_ID,
      releaseNote: "cleared",
    });

    const first = await standing.listHistory({ limit: 2, organizationId: ORGANIZATION_ID });
    const second = await standing.listHistory({
      ...(first.before === undefined ? {} : { before: first.before }),
      limit: 2,
      organizationId: ORGANIZATION_ID,
    });

    expect(first.items.map((item) => [item.standingVersion, item.change.kind, item.state])).toEqual(
      [
        [3, "hold-released", "active"],
        [2, "grant-set", "suspended"],
      ],
    );
    expect(first.before).toBe(2);
    expect<unknown>(second).toEqual({
      items: [
        {
          actor: { kind: "operator", principalId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" },
          change: {
            hold: {
              customerMessage: "Your organization is under review.",
              key: "tos-review",
              operatorNote: "ticket 4411",
              placedAt: "2026-10-01T00:00:00.000Z",
              placedBy: { kind: "operator", principalId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" },
              reason: "abuse",
            },
            kind: "hold-placed",
          },
          occurredAt: "2026-10-01T00:00:00.000Z",
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          standingVersion: 1,
          state: "suspended",
        },
      ],
    });
  });
});

describe("organization data boundary", () => {
  const setPhi = {
    actor: OPERATOR,
    operatorNote: "BAA-2026-17",
    organizationId: ORGANIZATION_ID,
    profile: "phi" as const,
  };
  const storedPhi = {
    operatorNote: "BAA-2026-17",
    profile: "phi",
    setAt: "2026-10-01T00:00:00.000Z",
    setBy: OPERATOR,
  };

  test("an operator sets a phi boundary with one history row and one event", async () => {
    const { events, memory, standing } = harness();

    const set = await standing.setDataBoundary(setPhi);

    expect(set.kind).toBe("changed");
    expect(set.standing.dataBoundary.profile).toBe("phi");
    expect(memory.transactions).toHaveLength(1);
    expect<unknown>((await standing.readWithGrants(ORGANIZATION_ID)).dataBoundary).toEqual(
      storedPhi,
    );
    expect<unknown>(
      (await standing.listHistory({ limit: 10, organizationId: ORGANIZATION_ID })).items,
    ).toEqual([
      {
        actor: OPERATOR,
        change: { dataBoundary: storedPhi, kind: "data-boundary-set" },
        occurredAt: "2026-10-01T00:00:00.000Z",
        organizationId: ORGANIZATION_ID,
        standingVersion: 1,
        state: "active",
      },
    ]);
    expect(events()).toEqual([
      [
        "organization.data-boundary-set",
        "organization-standing",
        1,
        { profile: "phi", source: "operator" },
      ],
    ]);
  });

  test("setting the profile already set is unchanged and keeps the first note", async () => {
    const { memory, standing } = harness();
    await standing.setDataBoundary(setPhi);

    const again = await standing.setDataBoundary({ ...setPhi, operatorNote: "BAA-2026-99" });

    expect(again.kind).toBe("unchanged");
    expect(memory.transactions).toHaveLength(1);
    expect<unknown>((await standing.readWithGrants(ORGANIZATION_ID)).dataBoundary).toEqual(
      storedPhi,
    );
  });

  test("refuses a service that sets or clears the boundary, naming the operator", async () => {
    const { memory, standing } = harness();
    await standing.setDataBoundary(setPhi);

    const refusedSet = await standing.setDataBoundary({ ...setPhi, actor: BILLING });
    const refusedClear = await standing.clearDataBoundary({
      actor: BILLING,
      operatorNote: "BAA ended",
      organizationId: ORGANIZATION_ID,
    });

    expect<unknown>(
      [refusedSet, refusedClear].map((outcome) => outcome.kind === "refused" && outcome.owner),
    ).toEqual(["operator", "operator"]);
    expect(refusedClear.standing.dataBoundary.profile).toBe("phi");
    expect(memory.transactions).toHaveLength(1);
  });

  test("grants and holds written after the boundary keep it", async () => {
    const { standing } = harness();
    await standing.setDataBoundary(setPhi);

    await standing.setGrant({
      actor: BILLING,
      entitlements: { tenantLimits: { concurrentRuns: 16 } },
      organizationId: ORGANIZATION_ID,
    });
    await standing.clearGrant({ actor: BILLING, organizationId: ORGANIZATION_ID });
    const held = await standing.placeHold(operatorHold);
    const released = await standing.releaseHold({
      actor: OPERATOR,
      key: TOS_REVIEW,
      organizationId: ORGANIZATION_ID,
    });

    expect([held, released].map((outcome) => outcome.standing.dataBoundary.profile)).toEqual([
      "phi",
      "phi",
    ]);
    expect<unknown>((await standing.readWithGrants(ORGANIZATION_ID)).dataBoundary).toEqual(
      storedPhi,
    );
  });

  test("clearing writes a history row and an event, and clearing again is unchanged", async () => {
    const { events, memory, standing } = harness();
    await standing.setDataBoundary(setPhi);
    const clear = {
      actor: OPERATOR,
      operatorNote: "BAA ended",
      organizationId: ORGANIZATION_ID,
    };

    const cleared = await standing.clearDataBoundary(clear);
    const clearedAgain = await standing.clearDataBoundary(clear);

    expect(cleared.kind).toBe("changed");
    expect(cleared.standing.dataBoundary).toEqual(OPEN_BOUNDARY);
    expect(clearedAgain.kind).toBe("unchanged");
    expect(memory.transactions).toHaveLength(2);
    expect((await standing.readWithGrants(ORGANIZATION_ID)).dataBoundary).toBeUndefined();
    expect<unknown>(
      (await standing.listHistory({ limit: 1, organizationId: ORGANIZATION_ID })).items[0]?.change,
    ).toEqual({ kind: "data-boundary-cleared", operatorNote: "BAA ended", profile: "phi" });
    expect(events().at(-1)).toEqual([
      "organization.data-boundary-cleared",
      "organization-standing",
      2,
      { profile: "phi", source: "operator" },
    ]);
  });

  test("clearing a boundary that was never set is unchanged and writes nothing", async () => {
    const { memory, standing } = harness();

    const cleared = await standing.clearDataBoundary({
      actor: OPERATOR,
      operatorNote: "BAA ended",
      organizationId: ORGANIZATION_ID,
    });

    expect(cleared.kind).toBe("unchanged");
    expect(memory.transactions).toHaveLength(0);
  });
});
