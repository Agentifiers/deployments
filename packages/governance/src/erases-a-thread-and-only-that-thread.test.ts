import { describe, expect, test } from "bun:test";
import {
  decodePlatformRecord,
  EndUserKey,
  governanceLegacyInventoryPartition,
  governanceTenantDirectoryKey,
  type GovernanceOperation,
} from "@deployments-ai/db";
import {
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  REQUESTER,
  SCOPE,
  runRecord,
  seedRecords,
  testId,
  threadRecord,
} from "@deployments-ai/db/erasure-testing";
import { Effect, Schema } from "effect";
import {
  conversation,
  conversationErasureFixture,
  ingressSource,
} from "./conversation-erasure-test-support.ts";
import {
  ORGANIZATION_ID as HARNESS_ORGANIZATION_ID,
  harness,
  record,
} from "./governance-service-test-harness.ts";

const ERASED = testId("T1");
const SIBLING = testId("T2");
const SIBLING_TYPES = [
  "conversation-checkpoint",
  "generation-reasoning",
  "inbound-thread-route",
  "memory",
  "message",
  "message",
  "run",
  "run-locator",
  "schedule",
  "stream-session",
  "thread",
  "tool-call",
];

async function erasedThreadFixture() {
  const fixture = conversationErasureFixture();
  await seedRecords(fixture.database, [
    ...conversation(ERASED, "1"),
    ...conversation(SIBLING, "2"),
    ingressSource("route-1", "after-fence", "2026-10-07T12:30:00.000Z"),
  ]);
  const request = await fixture.store.requestThreadErasure({
    requester: REQUESTER,
    scope: SCOPE,
    threadId: ERASED,
  });
  if (request.kind !== "created") throw new Error(`Erasure was not created: ${request.kind}.`);
  return { ...fixture, operation: request.operation };
}

async function ingressIds(fixture: ReturnType<typeof conversationErasureFixture>, routeId: string) {
  return (await fixture.store.listIngressRouteRecords(ORGANIZATION_ID, routeId))
    .flatMap(({ record }) =>
      "id" in record.data && typeof record.data.id === "string" ? [record.data.id] : [],
    )
    .sort();
}

describe("thread erasure", () => {
  test("erases every record, object, memory, timer, stream and ingress staging of the thread and nothing of its sibling", async () => {
    const fixture = await erasedThreadFixture();
    expect(await fixture.threadRecordTypes(SIBLING)).toEqual(SIBLING_TYPES);

    const completed = await fixture.runToCompletion(fixture.operation);

    expect(completed).toMatchObject({
      conversationErasure: { phase: "finalizing", target: { kind: "thread", threadId: ERASED } },
      status: "completed",
      summary: {
        automationsArchived: 1,
        ingressRecordsDeleted: 1,
        memoriesErased: 1,
        objectsStaged: 1,
        recordsDeleted: 11,
        runsCanceled: 0,
        streamsDeleted: 1,
        threadsErased: 1,
        threadsPlanned: 1,
      },
    });
    expect(await fixture.threadRecordTypes(ERASED)).toEqual([]);
    expect(await fixture.threadRecordTypes(SIBLING)).toEqual(SIBLING_TYPES);
    expect(await fixture.store.listItems(fixture.operation)).toEqual([]);
    expect(await fixture.store.getThreadTombstone(ORGANIZATION_ID, ERASED)).toMatchObject({
      data: { operationId: fixture.operation.id, threadId: ERASED },
    });
    expect(await ingressIds(fixture, "route-1")).toEqual(["after-fence"]);
    expect(await ingressIds(fixture, "route-2")).toEqual(["before-2"]);
    expect(fixture.calls.deletedObjects).toEqual([
      `organizations/${ORGANIZATION_ID}/threads/body-1`,
    ]);
    expect(fixture.calls.deletedTimers).toEqual([testId("D1")]);
    expect(fixture.calls.deletedStreams).toEqual([{ ...SCOPE, threadId: ERASED }]);
    expect(fixture.calls.purgedMemories.map((purge) => purge.threadId)).toEqual([ERASED]);
    expect(fixture.calls.observability.at(-1)).toMatchObject({
      operationId: fixture.operation.id,
      scope: { kind: "conversation", runIds: [testId("R1")], threadIds: [ERASED] },
    });
  });

  test("erases a thread whose locators are on both inventory partitions once and deletes both", async () => {
    const fixture = await erasedThreadFixture();
    const erasedThreadLocators = () =>
      fixture.fake.items("control").flatMap((item) => {
        const locator = Effect.runSync(decodePlatformRecord(item));
        return locator.itemType === "governance-tenant-record" &&
          locator.data.threadIds?.includes(ERASED)
          ? [locator]
          : [];
      });
    const legacyLocators = erasedThreadLocators();
    for (const locator of legacyLocators) {
      const { organizationId, recordPk, recordSk, recordTable } = locator.data;
      fixture.fake.put("control", {
        ...locator,
        pk: governanceTenantDirectoryKey(organizationId, recordTable, recordPk, recordSk).pk,
      });
    }
    expect(legacyLocators.map(({ pk }) => pk)).toContain(
      governanceLegacyInventoryPartition(ORGANIZATION_ID),
    );
    expect(erasedThreadLocators()).toHaveLength(legacyLocators.length * 2);

    const completed = await fixture.runToCompletion(fixture.operation);

    expect(completed.summary).toMatchObject({
      automationsArchived: 1,
      memoriesErased: 1,
      recordsDeleted: 11,
    });
    expect(fixture.calls.deletedTimers).toEqual([testId("D1")]);
    expect(fixture.calls.purgedMemories.map(({ memories }) => memories.length)).toEqual([1]);
    expect(erasedThreadLocators()).toEqual([]);
  });

  test("waits for the fence to settle before it calls the thread erased", async () => {
    const fixture = await erasedThreadFixture();

    const first = await fixture.service.runOperation(ORGANIZATION_ID, fixture.operation.id);

    expect(first).toMatchObject({
      conversationErasure: { phase: "canonical" },
      error: { code: "conversation_canonical_settling" },
      status: "pending",
    });
    expect(await fixture.threadRecordTypes(ERASED)).toEqual(["retention-cleanup"]);
  });

  for (const port of [
    "deletedTimers",
    "purgedMemories",
    "deletedObjects",
    "deletedStreams",
    "observability",
  ] as const) {
    test(`converges to the same end state after ${port} fails midway`, async () => {
      const fixture = await erasedThreadFixture();
      fixture.failures[port] = 1;

      const completed = await fixture.runToCompletion(fixture.operation);

      expect(completed.status).toBe("completed");
      expect(completed.summary).toMatchObject({ recordsDeleted: 11, threadsErased: 1 });
      expect(await fixture.threadRecordTypes(ERASED)).toEqual([]);
      expect(await fixture.threadRecordTypes(SIBLING)).toEqual(SIBLING_TYPES);
      expect(await ingressIds(fixture, "route-1")).toEqual(["after-fence"]);
      expect([...new Set(fixture.calls.deletedObjects)]).toEqual([
        `organizations/${ORGANIZATION_ID}/threads/body-1`,
      ]);
    });
  }

  test("a crashed worker's expired lease is reclaimed and the erasure finishes", async () => {
    const fixture = await erasedThreadFixture();
    await fixture.service.runOperation(ORGANIZATION_ID, fixture.operation.id);
    const pending = (await fixture.service.getOperation(ORGANIZATION_ID, fixture.operation.id))!;
    await fixture.governanceStore.claimOperation(
      {
        ...pending,
        leaseExpiresAt: "2026-10-07T12:16:00.000Z",
        status: "running",
        version: pending.version + 1,
      },
      pending.version,
    );
    fixture.advance(20 * 60_000);

    const completed = await fixture.runToCompletion(pending);

    expect(completed.status).toBe("completed");
    expect(await fixture.threadRecordTypes(ERASED)).toEqual([]);
  });
});

describe("end-user erasure", () => {
  const SUBJECT = Schema.decodeUnknownSync(EndUserKey)(`v1.${"s".repeat(43)}`);
  const OTHER = Schema.decodeUnknownSync(EndUserKey)(`v1.${"o".repeat(43)}`);

  test("cancels the subject's active runs and erases exactly the subject's threads", async () => {
    const fixture = conversationErasureFixture();
    await seedRecords(fixture.database, [
      threadRecord(testId("Q1"), { endUserKey: SUBJECT }),
      runRecord(testId("Q1"), testId("P1"), "running"),
      threadRecord(testId("Q2"), { endUserKey: SUBJECT }),
      threadRecord(testId("Q3"), { endUserKey: OTHER }),
      threadRecord(testId("Q4")),
    ]);
    const request = await fixture.store.requestEndUserErasure({
      endUserKey: SUBJECT,
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      requester: REQUESTER,
    });

    const completed: GovernanceOperation = await fixture.runToCompletion(request.operation);

    expect(completed).toMatchObject({
      conversationErasure: { target: { kind: "end-user" } },
      status: "completed",
      summary: { runsCanceled: 1, threadsErased: 2, threadsPlanned: 2 },
    });
    expect(JSON.stringify(completed)).not.toContain(SUBJECT);
    expect(fixture.calls.canceledRuns).toEqual([testId("P1")]);
    expect(fixture.calls.deletedStreams.map((thread) => thread.threadId).sort()).toEqual([
      testId("Q1"),
      testId("Q2"),
    ]);
    expect(await fixture.threadRecordTypes(testId("Q1"))).toEqual([]);
    expect(await fixture.threadRecordTypes(testId("Q2"))).toEqual([]);
    expect(await fixture.threadRecordTypes(testId("Q3"))).toEqual(["end-user-thread", "thread"]);
    expect(await fixture.threadRecordTypes(testId("Q4"))).toEqual(["thread"]);
    expect(
      fixture.store.requestEndUserErasure({
        endUserKey: SUBJECT,
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        requester: REQUESTER,
      }),
    ).resolves.toMatchObject({ kind: "created" });
  });
});

describe("tenant erasure", () => {
  test("refuses to start a thread erasure while it holds the organization fence", async () => {
    const fixture = await erasedThreadFixture();
    await fixture.governanceStore.beginErasure({
      createdAt: "2026-10-07T12:00:00.000Z",
      operationId: testId("Z1"),
      organizationId: ORGANIZATION_ID,
    });

    const refused = await fixture.service
      .runOperation(ORGANIZATION_ID, fixture.operation.id)
      .catch((cause: unknown) => cause);
    expect(refused).toMatchObject({ code: "tenant_erasure_in_progress" });
    expect(
      (await fixture.service.getOperation(ORGANIZATION_ID, fixture.operation.id))?.status,
    ).toBe("pending");
  });

  test("cancels a thread erasure whose worker lease expired", async () => {
    const stale = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    const running = {
      createdAt: "2026-07-24T23:00:00.000Z",
      dispatchReadyAt: "2026-07-24T23:00:00.000Z",
      id: stale,
      idempotencyKey: `thread-erasure:${stale}`,
      kind: "thread-erasure" as const,
      leaseExpiresAt: "2026-07-24T23:30:00.000Z",
      organizationId: HARNESS_ORGANIZATION_ID,
      requestedByPrincipalId: stale,
      startedAt: "2026-07-24T23:00:00.000Z",
      status: "running" as const,
      updatedAt: "2026-07-24T23:00:00.000Z",
      version: 2,
    };
    const fixture = harness([record("governance-operation", running, "control")]);
    fixture.operations.set(stale, running);
    const tenantErasure = await fixture.service.requestOperation({
      idempotencyKey: "erase-tenant",
      kind: "tenant-erasure",
      organizationId: HARNESS_ORGANIZATION_ID,
      principalId: stale,
    });

    await fixture.service.runOperation(HARNESS_ORGANIZATION_ID, tenantErasure.id);

    expect(fixture.operations.get(stale)).toMatchObject({
      error: { code: "operation_canceled_by_erasure" },
      kind: "thread-erasure",
      status: "canceled",
    });
  });
});
