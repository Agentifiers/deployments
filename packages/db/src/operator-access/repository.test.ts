import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import { Ulid } from "../ids.ts";
import { organizationRecord } from "../organization-standing/test-support.ts";
import { organizationAccess } from "../identity-federation/access.ts";
import { makeOperatorAccessRepository } from "./repository.ts";

const id = Schema.decodeUnknownSync(Ulid);
const ORGANIZATION = id("01ARZ3NDEKTSV4RRFFQ69G5FF0");
const ARCHIVED = id("01ARZ3NDEKTSV4RRFFQ69G5FF1");
const ADMINISTRATOR = id("01ARZ3NDEKTSV4RRFFQ69G5FF2");
const OTHER_ADMINISTRATOR = id("01ARZ3NDEKTSV4RRFFQ69G5FF3");

function harness() {
  const archived = organizationRecord(ARCHIVED);
  const memory = evaluationMemoryDatabase([
    organizationRecord(ORGANIZATION),
    { ...archived, data: { ...archived.data, status: "archived" } },
  ]);
  let clock = Date.parse("2026-11-03T12:00:00.000Z");
  let next = 0;
  const repository = makeOperatorAccessRepository({
    database: memory.database,
    generateId: () => id(`01ARZ3NDEKTSV4RRFFQ69G6${String(next++).padStart(3, "0")}`),
    now: () => new Date(clock),
  });
  const advance = (minutes: number) => {
    clock += minutes * 60_000;
  };
  const audit = () =>
    memory
      .all()
      .flatMap((record) =>
        record.itemType === "audit-event"
          ? [[record.data.action, record.data.actor.id, record.data.changes?.["grantId"]] as const]
          : [],
      )
      .toSorted(([left], [right]) => left.localeCompare(right));
  const admits = (principalId: Ulid) =>
    organizationAccess(memory.database, {
      now: new Date(clock),
      organizationId: ORGANIZATION,
      platformAdministrator: true,
      principalId,
    }).then((access) => access.kind);
  return { admits, advance, audit, memory, repository };
}

const OPEN = { organizationId: ORGANIZATION, principalId: ADMINISTRATOR, reason: "Case 42" };

describe("operator access repository", () => {
  test("opens, renews in place, closes, and audits each step in the organization", async () => {
    const { admits, advance, audit, repository } = harness();
    expect(await admits(ADMINISTRATOR)).toBe("operator-access-required");

    const opened = await repository.open({ ...OPEN, ticket: "SUP-1" });
    expect(opened).toMatchObject({
      access: { expiresAt: "2026-11-03T13:00:00.000Z", status: "open", version: 1 },
      kind: "opened",
    });
    expect(await admits(ADMINISTRATOR)).toBe("platform-administrator");
    expect(await admits(OTHER_ADMINISTRATOR)).toBe("operator-access-required");

    advance(30);
    const renewed = await repository.open({ ...OPEN, durationMinutes: 480 });
    expect(renewed.kind).toBe("renewed");
    expect(renewed.access.grantId).toBe(opened.access.grantId);
    expect(renewed.access.openedAt).toBe(opened.access.openedAt);
    expect(renewed.access.expiresAt).toBe("2026-11-03T20:30:00.000Z");

    const closed = await repository.close(OPEN);
    expect(closed).toMatchObject({ access: { status: "closed" }, changed: true });
    expect(await admits(ADMINISTRATOR)).toBe("operator-access-required");
    expect(await repository.close(OPEN)).toMatchObject({ changed: false });

    const grant = opened.access.grantId;
    expect(audit()).toEqual([
      ["organization.operator-access-closed", ADMINISTRATOR, grant],
      ["organization.operator-access-opened", ADMINISTRATOR, grant],
      ["organization.operator-access-renewed", ADMINISTRATOR, grant],
    ]);
  });

  test("expires on the clock and reopens as a new grant", async () => {
    const { admits, advance, repository } = harness();
    const first = await repository.open({ ...OPEN, durationMinutes: 5 });
    advance(5);
    expect(await admits(ADMINISTRATOR)).toBe("operator-access-required");
    expect((await repository.get(OPEN)).access?.status).toBe("expired");
    expect(await repository.close(OPEN)).toMatchObject({ changed: false });

    const second = await repository.open(OPEN);
    expect(second.kind).toBe("opened");
    expect(second.access.grantId).not.toBe(first.access.grantId);
    expect(second.access.version).toBe(2);
  });

  test("lists only unexpired open grants, install-wide and per organization", async () => {
    const { advance, repository } = harness();
    await repository.open({ ...OPEN, durationMinutes: 5 });
    await repository.open({ ...OPEN, principalId: OTHER_ADMINISTRATOR });
    expect((await repository.listOpen({})).items.map((item) => item.principalId)).toEqual([
      ADMINISTRATOR,
      OTHER_ADMINISTRATOR,
    ]);
    advance(10);
    expect((await repository.listOpen({})).items.map((item) => item.principalId)).toEqual([
      OTHER_ADMINISTRATOR,
    ]);
    await repository.close({ ...OPEN, principalId: OTHER_ADMINISTRATOR });
    expect((await repository.listOpen({})).items).toEqual([]);
    expect((await repository.listOpen({ organizationId: ORGANIZATION })).items).toEqual([]);
  });

  test("refuses archived and missing organizations and out-of-range durations", async () => {
    const { repository } = harness();
    expect(repository.open({ ...OPEN, organizationId: ARCHIVED })).rejects.toMatchObject({
      code: "organization_archived",
      kind: "conflict",
    });
    expect(
      repository.open({ ...OPEN, organizationId: id("01ARZ3NDEKTSV4RRFFQ69G5FF9") }),
    ).rejects.toMatchObject({ code: "organization_not_found", kind: "not-found" });
    for (const durationMinutes of [0, 481, 1.5]) {
      expect(repository.open({ ...OPEN, durationMinutes })).rejects.toMatchObject({
        code: "invalid_duration",
      });
    }
  });
});
