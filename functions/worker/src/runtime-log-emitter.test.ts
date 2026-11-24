import { describe, expect, test } from "bun:test";
import type { RuntimeProgressEvent } from "@deployments-ai/agent-runtime";
import {
  RunRecord,
  makeDynamoDatabase,
  makeRuntimeLogPersistence,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { stableSpanId, type CaptureMode, type TraceId } from "@deployments-ai/observability";
import { Schema } from "effect";
import {
  createRuntimeRunLogger,
  makeRuntimeRunLogRegistry,
  progressLogEntry,
  runtimeLogLine,
} from "./runtime-log-emitter.ts";

const TABLES = { control: "control", events: "events", execution: "execution", usage: "usage" };
const id = (suffix: number) => `01ARZ3NDEKTSV4RRFFQ69G5${String(suffix).padStart(3, "0")}` as Ulid;
const organizationId = id(1);
const traceId = "0123456789abcdef0123456789abcdef";
const toolCallId = id(9);
const time = "2026-11-02T12:00:00.000Z";
const SECRET_LINE = "calling api_key=sk-live-0123456789abcdefghij with Bearer abc.def.ghi";

function run(captureMode: CaptureMode) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: id(5),
        agentReleaseId: id(6),
        attempt: 2,
        captureMode,
        createdAt: time,
        environmentId: id(3),
        executor: "hosted",
        id: id(4),
        idempotencyKey: "run-logs",
        organizationId,
        priority: 50,
        projectId: id(2),
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status: "running" as const,
        threadId: id(7),
        trigger: "api",
        traceId,
        updatedAt: time,
        userMessageId: id(8),
        userMessageSequence: 0,
        version: 1,
      },
      itemType: "run" as const,
    }),
  );
}

function logger(captureMode: CaptureMode) {
  const fake = fakeDynamoDocumentClient();
  fake.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: time,
        id: organizationId,
        name: "Logs",
        slug: "logs",
        status: "active" as const,
        updatedAt: time,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  const database = makeDynamoDatabase(fake.client, TABLES);
  const record = run(captureMode);
  const runLogger = createRuntimeRunLogger({
    database,
    now: () => new Date(time),
    run: record,
    workerId: "worker-1",
  });
  const stored = async () => {
    const page = await makeRuntimeLogPersistence(database).listRunBatches(
      {
        environmentId: record.data.environmentId,
        organizationId,
        projectId: record.data.projectId,
        runId: record.data.id,
      },
      { limit: 100, now: new Date(time) },
    );
    return page.batches;
  };
  return { record, runLogger, stored };
}

function progress(overrides: Partial<RuntimeProgressEvent> = {}): RuntimeProgressEvent {
  return {
    agentManifestHash: "manifest",
    captureMode: "metadata-only",
    environmentId: id(3),
    eventType: "tool.running",
    level: "info",
    message: "Running tool lookup.",
    metadata: { inputSummary: "customer email a@b.example", toolCallId, toolName: "lookup" },
    occurredAt: time,
    organizationId,
    projectId: id(2),
    runId: id(4),
    spanId: "0123456789abcdef",
    threadId: id(7),
    traceId,
    ...overrides,
  } as RuntimeProgressEvent;
}

describe("runtime log lines", () => {
  test("maps a progress event to a source, its tool call, and the tool call's span", () => {
    const entry = progressLogEntry(progress());
    expect(entry).toMatchObject({
      level: "info",
      message: "Running tool lookup.",
      source: "tool",
      spanId: stableSpanId(traceId as TraceId, `tool:${toolCallId}`),
      toolCallId,
    });
    expect(entry.attributes).toMatchObject({ event: "tool.running", toolName: "lookup" });
    expect(progressLogEntry(progress({ eventType: "model.generation.started" }))).toMatchObject({
      source: "model",
    });
    expect(progressLogEntry(progress({ eventType: "run.started", metadata: {} }))).toMatchObject({
      source: "runtime",
      spanId: "0123456789abcdef",
    });
    expect(progressLogEntry(progress({ eventType: "sandbox.ready" })).source).toBe("sandbox");
  });

  test("metadata-only drops content-bearing attributes and redacts secrets in the message", () => {
    const line = runtimeLogLine(
      { ...progressLogEntry(progress()), message: SECRET_LINE },
      "metadata-only",
      0,
    );
    expect(line.attributes).toEqual({ event: "tool.running", toolName: "lookup" });
    expect(line.message).not.toContain("sk-live-0123456789abcdefghij");
    expect(line.message).not.toContain("abc.def.ghi");
    expect(line.message).toContain("[redacted");
  });

  test("redacted-content keeps content attributes but still redacts their secrets", () => {
    const line = runtimeLogLine(
      {
        attributes: { inputSummary: "token=hunter2-secret-value", toolName: "lookup" },
        level: "info",
        message: SECRET_LINE,
        source: "tool",
        time,
      },
      "redacted-content",
      0,
    );
    expect(line.attributes?.inputSummary).toBe("token=[redacted]");
    expect(line.message).not.toContain("sk-live-0123456789abcdefghij");
  });

  test("full-content keeps text verbatim", () => {
    const line = runtimeLogLine(
      { level: "info", message: SECRET_LINE, source: "tool", time },
      "full-content",
      0,
    );
    expect(line.message).toBe(SECRET_LINE);
  });

  test("bounds messages, attribute values, and attribute count, and drops non-scalars", () => {
    const attributes = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`a${String(index).padStart(2, "0")}`, index]),
    );
    const line = runtimeLogLine(
      {
        attributes: { ...attributes, nested: { deep: true }, list: ["x", "y"] },
        level: "info",
        message: "m".repeat(5_000),
        source: "runtime",
        time,
      },
      "full-content",
      0,
    );
    expect(line.message).toHaveLength(2_000);
    expect(line.message.endsWith("…")).toBe(true);
    expect(Object.keys(line.attributes ?? {})).toHaveLength(16);
    expect(line.attributes?.nested).toBeUndefined();
    expect(
      runtimeLogLine(
        {
          attributes: { long: "v".repeat(400) },
          level: "info",
          message: "x",
          source: "tool",
          time,
        },
        "full-content",
        0,
      ).attributes?.long,
    ).toHaveLength(256);
  });
});

describe("runtime run logger", () => {
  test("stores lines in batches of fifty under the run's attempt, in order", async () => {
    const { runLogger, stored } = logger("metadata-only");
    for (let index = 0; index < 120; index += 1) {
      runLogger.log({ level: "info", message: `line ${index}`, source: "runtime", time });
    }
    await runLogger.close();

    const batches = await stored();
    expect(
      batches.map((batch) => [batch.data.attempt, batch.data.batch, batch.data.lines.length]),
    ).toEqual([
      [2, 0, 50],
      [2, 1, 50],
      [2, 2, 20],
    ]);
    expect(batches.flatMap((batch) => batch.data.lines.map((line) => line.message)).at(-1)).toBe(
      "line 119",
    );
    expect(batches[0]?.data.workerId).toBe("worker-1");
  });

  test("keeps at most a thousand lines per execution and marks the cut", async () => {
    const { runLogger, stored } = logger("metadata-only");
    for (let index = 0; index < 1_200; index += 1) {
      runLogger.log({ level: "debug", message: `line ${index}`, source: "runtime", time });
    }
    await runLogger.close();
    runLogger.log({ level: "info", message: "after close", source: "runtime", time });

    const lines = (await stored()).flatMap((batch) => batch.data.lines);
    expect(lines).toHaveLength(1_000);
    expect(lines.at(-1)).toMatchObject({ level: "warn", source: "runtime" });
    expect(lines.at(-1)?.message).toContain("1000 log lines");
  });

  test("keeps process output only when the capture mode captures content", async () => {
    const output = {
      level: "info" as const,
      source: "hosted-code" as const,
      text: "starting\nDB_PASSWORD=swordfish\n\nfinished\n",
      time,
      toolCallId,
    };
    const metadataOnly = logger("metadata-only");
    metadataOnly.runLogger.processOutput(output);
    await metadataOnly.runLogger.close();
    expect(await metadataOnly.stored()).toEqual([]);

    const redacted = logger("redacted-content");
    redacted.runLogger.processOutput(output);
    await redacted.runLogger.close();
    const lines = (await redacted.stored()).flatMap((batch) => batch.data.lines);
    expect(lines.map((line) => line.message)).toEqual([
      "starting",
      "DB_PASSWORD=[redacted]",
      "finished",
    ]);
    expect(lines[0]).toMatchObject({
      source: "hosted-code",
      spanId: stableSpanId(traceId as TraceId, `tool:${toolCallId}`),
      toolCallId,
    });
  });

  test("caps process output per call and says how much was left out", async () => {
    const { runLogger, stored } = logger("full-content");
    runLogger.processOutput({
      level: "info",
      source: "hosted-code",
      text: Array.from({ length: 250 }, (_, index) => `out ${index}`).join("\n"),
      time,
    });
    await runLogger.close();
    const lines = (await stored()).flatMap((batch) => batch.data.lines);
    expect(lines).toHaveLength(201);
    expect(lines.at(-1)?.message).toBe("50 more output lines were not kept.");
  });

  test("never throws when a batch cannot be stored", async () => {
    const failing = createRuntimeRunLogger({
      database: { putRecord: () => Promise.reject(new Error("throttled")) } as never,
      now: () => new Date(time),
      run: run("metadata-only"),
      workerId: "worker-1",
    });
    failing.log({ level: "info", message: "lost", source: "runtime", time });
    expect(await failing.close()).toBeUndefined();
  });

  test("the registry hands a run's logger to tools and forgets it after the execution", () => {
    const registry = makeRuntimeRunLogRegistry();
    const { record, runLogger } = logger("metadata-only");
    const unregister = registry.register(record.data.id, runLogger);
    expect(registry.logger(record.data.id)).toBe(runLogger);
    unregister();
    expect(registry.logger(record.data.id)).toBeUndefined();
  });
});
