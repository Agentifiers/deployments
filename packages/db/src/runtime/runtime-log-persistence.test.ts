import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DEFAULT_TABLE_NAMES } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { THREAD_OWNERSHIP } from "../thread-erasure/ownership.ts";
import {
  makeRuntimeLogPersistence,
  runtimeLogBatchRecord,
  type RuntimeLogBatchInput,
} from "./runtime-log-persistence.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G5${suffix.padStart(3, "0")}`);
const ORG_ID = id("1");
const PROJECT_ID = id("2");
const ENVIRONMENT_ID = id("3");
const RUN_ID = id("4");
const THREAD_ID = id("5");
const NOW = new Date("2026-11-02T12:00:00.000Z");
const scope = {
  environmentId: ENVIRONMENT_ID,
  organizationId: ORG_ID,
  projectId: PROJECT_ID,
  runId: RUN_ID,
};

function batch(attempt: number, number: number, message: string): RuntimeLogBatchInput {
  return {
    attempt,
    batch: number,
    captureMode: "metadata-only",
    createdAt: "2026-11-02T10:00:00.000Z",
    environmentId: ENVIRONMENT_ID,
    lines: [
      {
        level: "info",
        message,
        sequence: 0,
        source: "runtime",
        time: "2026-11-02T10:00:00.000Z",
      },
    ],
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    threadId: THREAD_ID,
    traceId: "0123456789abcdef0123456789abcdef",
  } as RuntimeLogBatchInput;
}

function persistence() {
  const fake = fakeDynamoDocumentClient();
  fake.put(
    DEFAULT_TABLE_NAMES.control,
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-11-01T00:00:00.000Z",
        id: ORG_ID,
        name: "Runtime Logs Organization",
        slug: "runtime-logs-organization",
        status: "active",
        updatedAt: "2026-11-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization",
    }),
  );
  return {
    fake,
    logs: makeRuntimeLogPersistence(makeDynamoDatabase(fake.client, DEFAULT_TABLE_NAMES)),
  };
}

describe("runtime log persistence", () => {
  test("keys a batch under its run so attempts and batches read back in execution order", async () => {
    const { logs } = persistence();
    await logs.appendBatch(batch(2, 0, "second attempt"));
    await logs.appendBatch(batch(1, 10, "first attempt, batch ten"));
    await logs.appendBatch(batch(1, 2, "first attempt, batch two"));

    const page = await logs.listRunBatches(scope, { limit: 10, now: NOW });

    expect(page.batches.map((record) => record.data.lines[0]?.message)).toEqual([
      "first attempt, batch two",
      "first attempt, batch ten",
      "second attempt",
    ]);
    expect(page.batches[0]?.pk).toBe(`ORG#${ORG_ID}#RUN#${RUN_ID}`);
  });

  test("treats a retried flush of the same batch as already stored", async () => {
    const { fake, logs } = persistence();
    await logs.appendBatch(batch(1, 0, "original"));
    await logs.appendBatch(batch(1, 0, "retry"));

    const page = await logs.listRunBatches(scope, { limit: 10, now: NOW });
    expect(page.batches.map((record) => record.data.lines[0]?.message)).toEqual(["original"]);
    expect(
      fake
        .items(DEFAULT_TABLE_NAMES.execution)
        .filter((item) => item.itemType === "runtime-log-batch"),
    ).toHaveLength(1);
  });

  test("continues a page from the last evaluated key", async () => {
    const { logs } = persistence();
    for (const number of [0, 1, 2]) await logs.appendBatch(batch(1, number, `batch ${number}`));

    const first = await logs.listRunBatches(scope, { limit: 2, now: NOW });
    const second = await logs.listRunBatches(scope, {
      exclusiveStartKey: first.lastEvaluatedKey,
      limit: 2,
      now: NOW,
    });

    expect(first.batches).toHaveLength(2);
    expect(second.batches.map((record) => record.data.batch)).toEqual([2]);
  });

  test("expires a batch with the span retention window, before DynamoDB TTL removes it", async () => {
    const { logs } = persistence();
    await logs.appendBatch(batch(1, 0, "kept for thirty days"));
    const record = runtimeLogBatchRecord(batch(1, 0, "x"));

    expect(record.data.expiresAt).toBe("2026-12-02T10:00:00.000Z");
    expect(record.ttl).toBe(Date.parse("2026-12-02T10:00:00.000Z") / 1_000);
    const later = new Date("2026-12-02T10:00:00.001Z");
    expect((await logs.listRunBatches(scope, { limit: 10, now: later })).batches).toEqual([]);
  });

  test("drops a batch for an organization that no longer exists", async () => {
    const fake = fakeDynamoDocumentClient();
    const logs = makeRuntimeLogPersistence(makeDynamoDatabase(fake.client, DEFAULT_TABLE_NAMES));
    await logs.appendBatch(batch(1, 0, "after erasure"));
    expect(
      fake
        .items(DEFAULT_TABLE_NAMES.execution)
        .filter((item) => item.itemType === "runtime-log-batch"),
    ).toEqual([]);
  });

  test("rejects batches over the line bound and lines over the message bound", () => {
    const base = batch(1, 0, "x");
    const line = base.lines[0]!;
    expect(() =>
      runtimeLogBatchRecord({
        ...base,
        lines: Array.from({ length: 51 }, (_, sequence) => ({ ...line, sequence })),
      }),
    ).toThrow();
    expect(() =>
      runtimeLogBatchRecord({ ...base, lines: [{ ...line, message: "x".repeat(2_001) }] }),
    ).toThrow();
  });

  test("is erased with its thread", () => {
    const record = runtimeLogBatchRecord(batch(1, 0, "x"));
    const ownership = THREAD_OWNERSHIP["runtime-log-batch"];
    expect(ownership.kind).toBe("owned");
    expect(ownership.kind === "owned" ? ownership.threads(record.data) : []).toEqual([THREAD_ID]);
  });
});
