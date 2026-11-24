import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { AgentPlanUpdate } from "@deployments-ai/streaming";
import {
  RuntimeLeaseRecord,
  RunRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "../index.ts";
import { Ulid } from "../ids.ts";
import { makeAgentRunPlanPersistence } from "./agent-run-plan-persistence.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);
const timestamp = "2026-08-12T12:00:00.000Z";
const storeKey = (record: PlatformRecord) =>
  `${tableForItemType(record.itemType)}\0${record.pk}\0${record.sk}`;

function fixture() {
  const runId = id("1");
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: id("2"),
        agentReleaseId: id("3"),
        attempt: 0,
        captureMode: "metadata-only" as const,
        claimedAt: timestamp,
        claimedBy: "worker-1",
        createdAt: timestamp,
        environmentId: id("4"),
        executor: "hosted",
        heartbeatAt: timestamp,
        id: runId,
        idempotencyKey: "run/plan-test",
        organizationId: id("5"),
        priority: 1,
        projectId: id("6"),
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status: "running" as const,
        threadId: id("7"),
        traceId: "0123456789abcdef0123456789abcdef",
        trigger: "api",
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "run" as const,
    }),
  );
  const lease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        acquiredAt: timestamp,
        environmentId: run.data.environmentId,
        expiresAt: "2026-08-12T12:05:00.000Z",
        id: run.data.threadId,
        leaseKey: `agent-run-thread/${run.data.threadId}`,
        organizationId: run.data.organizationId,
        owner: "worker-1",
        projectId: run.data.projectId,
        runId,
        threadId: run.data.threadId,
        version: 0,
      },
      itemType: "runtime-lease" as const,
    }),
  );
  const records = new Map<string, PlatformRecord>(
    [run, lease].map((record): [string, PlatformRecord] => [storeKey(record), record]),
  );
  const transactions: readonly TransactionOperation[][] = [];
  const mutableTransactions = transactions as TransactionOperation[][];
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: async (table, key) => records.get(`${table}\0${key.pk}\0${key.sk}`),
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      mutableTransactions.push([...operations]);
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "put") records.set(storeKey(operation.record), operation.record);
      }
    },
  };
  return { database, lease, records, run, transactions };
}

function update(
  revision: number,
  status: "completed" | "in_progress" | "pending" = "pending",
): AgentPlanUpdate {
  const task = { id: "respond", order: 0, status, title: "Produce the response" };
  return revision === 1
    ? {
        eventType: "agent.plan.updated",
        plan: { revision, tasks: [task], title: "Complete the request" },
      }
    : {
        eventType: "agent.task.updated",
        plan: { revision, title: "Complete the request" },
        task,
      };
}

describe("agent run plan persistence", () => {
  test("persists snapshots and transitions with run and lease fences", async () => {
    const test = fixture();
    const persistence = makeAgentRunPlanPersistence(test.database);
    const base = {
      environmentId: test.run.data.environmentId,
      expectedLease: test.lease,
      expectedRun: test.run,
      occurredAt: timestamp,
      organizationId: test.run.data.organizationId,
      projectId: test.run.data.projectId,
      runAttempt: 0,
      runClaimedAt: test.run.data.claimedAt!,
      runExecutionVersion: 1,
      runId: test.run.data.id,
      threadId: test.run.data.threadId,
      traceId: test.run.data.traceId,
    };
    const initial = await persistence.persist({ ...base, eventId: id("8"), update: update(1) });
    const transitioned = await persistence.persist({
      ...base,
      eventId: id("9"),
      update: update(2, "completed"),
    });
    const stale = await persistence.persist({ ...base, eventId: id("10"), update: update(1) });
    const replay = await persistence.persist({
      ...base,
      eventId: id("11"),
      update: update(2, "completed"),
    });

    expect(initial).toMatchObject({ record: { data: { version: 0 } }, shouldPublish: true });
    expect(transitioned).toMatchObject({
      record: { data: { planRevision: 2, tasks: [{ status: "completed" }], version: 1 } },
      shouldPublish: true,
    });
    expect(stale.shouldPublish).toBe(false);
    expect(replay).toMatchObject({
      record: { data: { planRevision: 2, version: 1 } },
      shouldPublish: true,
    });
    expect(test.transactions).toHaveLength(2);
    expect(
      test.transactions[0]!.filter((operation) => operation.kind === "condition-check"),
    ).toHaveLength(2);
    expect(
      test.transactions
        .flat()
        .filter(
          (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
        ),
    ).toHaveLength(2);
  });

  test("requires an initial snapshot and the active lease", async () => {
    const test = fixture();
    const persistence = makeAgentRunPlanPersistence(test.database);
    const base = {
      environmentId: test.run.data.environmentId,
      eventId: id("8"),
      expectedLease: test.lease,
      expectedRun: test.run,
      occurredAt: timestamp,
      organizationId: test.run.data.organizationId,
      projectId: test.run.data.projectId,
      runAttempt: 0,
      runClaimedAt: test.run.data.claimedAt!,
      runExecutionVersion: 1,
      runId: test.run.data.id,
      threadId: test.run.data.threadId,
      traceId: test.run.data.traceId,
    };
    expect(persistence.persist({ ...base, update: update(2) })).rejects.toThrow(
      "require a plan snapshot",
    );
    expect(persistence.persist({ ...base, runId: id("11"), update: update(1) })).rejects.toThrow(
      "active run execution lease",
    );
  });
});
