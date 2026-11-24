import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import { Ulid } from "../ids.ts";
import { egressAllowlistIssues } from "./egress-allowlist-rules.ts";
import {
  makeOrganizationEgressAllowlistReader,
  makeOrganizationEgressAllowlistRepository,
} from "./egress-allowlist.ts";
import { ORGANIZATION_ID, minuteClock, organizationRecord } from "./test-support.ts";

const ADMIN = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB2");
let eventSequence = 0;
const nextEventId = () =>
  Schema.decodeUnknownSync(Ulid)(
    `01ARZ3NDEKTSV4RRFFQ69G${String(++eventSequence).padStart(4, "0")}`,
  );

function harness(wrap: (database: DynamoDatabaseService) => DynamoDatabaseService = (d) => d) {
  const memory = evaluationMemoryDatabase([organizationRecord(ORGANIZATION_ID)]);
  const database = wrap(memory.database);
  const allowlist = makeOrganizationEgressAllowlistRepository(database, {
    generateId: nextEventId,
    now: minuteClock(),
  });
  const events = () =>
    memory
      .all()
      .flatMap((record) =>
        record.itemType === "semantic-event"
          ? [[record.data.eventType, record.data.aggregateVersion, record.data.payload] as const]
          : [],
      );
  const stored = () =>
    memory
      .all()
      .flatMap((record) =>
        record.itemType === "organization-egress-allowlist"
          ? [{ pk: record.pk, sk: record.sk, version: record.data.version }]
          : [],
      );
  return { allowlist, database, events, memory, stored };
}

const replace = (entries: readonly { origin: string; note?: string }[]) => ({
  entries,
  organizationId: ORGANIZATION_ID,
  principalId: ADMIN,
});

describe("organization egress allowlist repository", () => {
  test("a missing allowlist reads as version 0 with no entries", async () => {
    const { allowlist, database } = harness();
    expect(await allowlist.read(ORGANIZATION_ID)).toEqual({
      entries: [],
      organizationId: ORGANIZATION_ID,
      updatedAt: undefined,
      updatedByPrincipalId: undefined,
      version: 0,
    });
    expect(await makeOrganizationEgressAllowlistReader(database).read(ORGANIZATION_ID)).toEqual([]);
  });

  test("the first replace creates version 1 under the organization partition with an event", async () => {
    const { allowlist, events, stored } = harness();

    const result = await allowlist.replace(
      replace([
        { note: "Claims clearinghouse", origin: "https://claims.example.com" },
        { origin: "https://api.example.org:8443" },
      ]),
    );

    expect(result).toEqual({
      allowlist: {
        entries: [
          { origin: "https://api.example.org:8443" },
          { note: "Claims clearinghouse", origin: "https://claims.example.com" },
        ],
        organizationId: ORGANIZATION_ID,
        updatedAt: "2026-10-01T00:00:00.000Z",
        updatedByPrincipalId: ADMIN,
        version: 1,
      },
      changed: true,
    });
    expect(stored()).toEqual([
      { pk: `ORG#${ORGANIZATION_ID}`, sk: "ORGANIZATION-EGRESS-ALLOWLIST", version: 1 },
    ]);
    expect(events()).toEqual([
      [
        "organization.egress-allowlist-updated",
        1,
        { added: ["https://api.example.org:8443", "https://claims.example.com"], removed: [] },
      ],
    ]);
  });

  test("a replace that adds and removes writes the next version and names both", async () => {
    const { allowlist, events, memory } = harness();
    await allowlist.replace(
      replace([{ origin: "https://a.example.com" }, { origin: "https://b.example.com" }]),
    );

    const result = await allowlist.replace(
      replace([{ origin: "https://b.example.com" }, { origin: "https://c.example.com" }]),
    );

    expect(result.changed).toBe(true);
    expect(result.allowlist.version).toBe(2);
    expect(memory.transactions[1]?.[0]).toMatchObject({
      kind: "put",
      previousRecord: { data: { version: 1 } },
      record: { data: { version: 2 } },
    });
    expect(events().at(-1)).toEqual([
      "organization.egress-allowlist-updated",
      2,
      { added: ["https://c.example.com"], removed: ["https://a.example.com"] },
    ]);
  });

  test("a changed note alone is a change with empty added and removed", async () => {
    const { allowlist, events } = harness();
    await allowlist.replace(replace([{ origin: "https://a.example.com" }]));

    const result = await allowlist.replace(
      replace([{ note: "Lab results", origin: "https://a.example.com" }]),
    );

    expect(result.changed).toBe(true);
    expect(events().at(-1)).toEqual([
      "organization.egress-allowlist-updated",
      2,
      { added: [], removed: [] },
    ]);
  });

  test("replacing with the same origins and notes in another order writes nothing", async () => {
    const { allowlist, memory } = harness();
    const first = await allowlist.replace(
      replace([
        { note: "x", origin: "https://a.example.com" },
        { origin: "https://b.example.com" },
      ]),
    );

    const again = await allowlist.replace(
      replace([
        { origin: "https://b.example.com" },
        { note: "x", origin: "https://a.example.com" },
      ]),
    );

    expect(again).toEqual({ allowlist: first.allowlist, changed: false });
    expect(memory.transactions).toHaveLength(1);
  });

  test("an empty replace of a missing allowlist writes nothing", async () => {
    const { allowlist, memory } = harness();
    expect((await allowlist.replace(replace([]))).changed).toBe(false);
    expect(memory.transactions).toHaveLength(0);
  });

  test("a writer that loses the version condition reloads and applies its list", async () => {
    let raced = false;
    const { allowlist, events } = harness((database) => ({
      ...database,
      transactWrite: async (operations, ...rest) => {
        if (!raced) {
          raced = true;
          await makeOrganizationEgressAllowlistRepository(database, {
            generateId: nextEventId,
          }).replace(replace([{ origin: "https://rival.example.com" }]));
        }
        return database.transactWrite(operations, ...rest);
      },
    }));

    const result = await allowlist.replace(replace([{ origin: "https://mine.example.com" }]));

    expect(result.allowlist).toMatchObject({
      entries: [{ origin: "https://mine.example.com" }],
      version: 2,
    });
    expect(events().map(([, version, payload]) => [version, payload])).toEqual([
      [1, { added: ["https://rival.example.com"], removed: [] }],
      [2, { added: ["https://mine.example.com"], removed: ["https://rival.example.com"] }],
    ]);
  });

  test("a version conflict that never settles fails as a conflict", async () => {
    const { allowlist } = harness((database) => ({
      ...database,
      transactWrite: async () => {
        throw Object.assign(new Error("lost"), { name: "ConditionalCheckFailedException" });
      },
    }));

    const refused = await allowlist
      .replace(replace([{ origin: "https://a.example.com" }]))
      .catch((cause: unknown) => cause);
    expect(refused).toMatchObject({ code: "version_conflict", kind: "conflict" });
  });

  test("refuses an organization that does not exist", async () => {
    const memory = evaluationMemoryDatabase([]);
    const allowlist = makeOrganizationEgressAllowlistRepository(memory.database);
    const refused = await allowlist.replace(replace([])).catch((cause: unknown) => cause);
    expect(refused).toMatchObject({ code: "organization_not_found" });
  });

  test("the record schema refuses entries that break the rules", async () => {
    const { allowlist, memory } = harness();
    const refused = await allowlist
      .replace(replace([{ origin: "http://plain.example.com" }]))
      .catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(Error);
    expect(memory.transactions).toHaveLength(0);
  });
});

describe("organization egress allowlist reader", () => {
  test("reads strongly consistent and returns the stored entries", async () => {
    const reads: (boolean | undefined)[] = [];
    const { allowlist, database } = harness();
    await allowlist.replace(replace([{ origin: "https://a.example.com" }]));
    const reader = makeOrganizationEgressAllowlistReader({
      ...database,
      getRecord: (table, recordKey, consistent) => {
        reads.push(consistent);
        return database.getRecord(table, recordKey, consistent);
      },
    });

    expect(await reader.read(ORGANIZATION_ID)).toEqual([{ origin: "https://a.example.com" }]);
    expect(reads).toEqual([true]);
  });

  test("a read error propagates so callers fail closed", async () => {
    const { database } = harness();
    const reader = makeOrganizationEgressAllowlistReader({
      ...database,
      getRecord: async () => {
        throw new Error("DynamoDB unavailable");
      },
    });
    const failed = await reader.read(ORGANIZATION_ID).catch((cause: unknown) => cause);
    expect(failed).toEqual(new Error("DynamoDB unavailable"));
  });
});

describe("egress allowlist rules", () => {
  test("names each broken rule with a pointer", () => {
    expect(
      egressAllowlistIssues([
        { origin: "http://a.example.com" },
        { origin: "https://a.example.com/path" },
        { origin: "https://a.example.com?q=1" },
        { origin: "https://user:secret@a.example.com" },
        { origin: "https://*.example.com" },
        { origin: "https://A.example.com" },
        { origin: "https://b.example.com" },
        { origin: "https://b.example.com" },
        { note: " ", origin: "https://c.example.com" },
        { note: "x".repeat(201), origin: "https://d.example.com" },
      ]),
    ).toEqual([
      { message: "Use https. Plain http is not allowed.", pointer: "/entries/0/origin" },
      {
        message: "Enter only the origin, without a path, query, or fragment.",
        pointer: "/entries/1/origin",
      },
      {
        message: "Enter only the origin, without a path, query, or fragment.",
        pointer: "/entries/2/origin",
      },
      { message: "Remove the credentials from the origin.", pointer: "/entries/3/origin" },
      { message: "Wildcards are not allowed. List each origin.", pointer: "/entries/4/origin" },
      { message: "Write it as https://a.example.com.", pointer: "/entries/5/origin" },
      { message: "https://b.example.com is already entry 6.", pointer: "/entries/7/origin" },
      {
        message: "A note must not be blank. Leave it out instead.",
        pointer: "/entries/8/note",
      },
      { message: "Keep the note to 200 characters.", pointer: "/entries/9/note" },
    ]);
  });

  test("allows 200 origins and refuses 201", () => {
    const origins = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ origin: `https://h${index}.example.com` }));
    expect(egressAllowlistIssues(origins(200))).toEqual([]);
    expect(egressAllowlistIssues(origins(201))).toEqual([
      { message: "An allowlist holds at most 200 origins.", pointer: "/entries" },
    ]);
  });
});
