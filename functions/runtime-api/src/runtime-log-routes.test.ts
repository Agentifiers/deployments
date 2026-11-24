import { describe, expect, test } from "bun:test";
import {
  makeDynamoDatabase,
  makeRuntimeLogPersistence,
  tableForItemType,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type RuntimeLogBatchInput,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import type { RuntimeRouteContext } from "./runtime-handler.ts";
import {
  environmentId,
  ids,
  now,
  organizationId,
  principal,
  projectId,
  runLocator,
  runRecord,
} from "./runtime-lifecycle.fixture.ts";
import { handleRuntimeLogRoutes } from "./runtime-log-routes.ts";
import {
  problem,
  runtimeApiErrorFromCause,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

const TABLES = { control: "control", events: "events", execution: "execution", usage: "usage" };
const run = runRecord("running");
const toolCallId = ids[20]!;

type Line = RuntimeLogBatchInput["lines"][number];

function line(sequence: number, overrides: Partial<Line> = {}): Line {
  return {
    level: "info",
    message: `line ${sequence}`,
    sequence,
    source: "runtime",
    time: new Date(now.getTime() + sequence * 1_000).toISOString(),
    ...overrides,
  } as Line;
}

function batchInput(attempt: number, batch: number, lines: readonly Line[]): RuntimeLogBatchInput {
  return {
    attempt,
    batch,
    captureMode: "metadata-only",
    createdAt: now.toISOString(),
    environmentId,
    lines,
    organizationId,
    projectId,
    runId: run.data.id,
    threadId: run.data.threadId,
    traceId: run.data.traceId,
  } as RuntimeLogBatchInput;
}

async function fixture(batches: readonly RuntimeLogBatchInput[]) {
  const fake = fakeDynamoDocumentClient();
  const organization = withCanonicalRecordKeys({
    data: {
      createdAt: now.toISOString(),
      id: organizationId,
      name: "Logs",
      slug: "logs",
      status: "active" as const,
      updatedAt: now.toISOString(),
      version: 1,
    },
    itemType: "organization" as const,
  }) as PlatformRecord;
  for (const record of [organization, run, runLocator(run)] as PlatformRecord[]) {
    fake.put(tableForItemType(record.itemType), record);
  }
  const database = makeDynamoDatabase(fake.client, TABLES);
  const logs = makeRuntimeLogPersistence(database);
  for (const batch of batches) await logs.appendBatch(batch);
  const dependencies = {
    database,
    now: () => now,
    sessionTokenSecret: "runtime-log-route-test-secret".repeat(2),
  } as unknown as RuntimeApiDependencies;
  const list = async (
    query: Record<string, string> = {},
    options: { readonly principal?: RuntimeApiPrincipal; readonly runId?: Ulid } = {},
  ) => {
    const result = await handleRuntimeLogRoutes({
      body: {},
      dependencies,
      event: { queryStringParameters: query, rawPath: "" },
      method: "GET",
      path: `/v1/runs/${options.runId ?? run.data.id}/logs`,
      principal: options.principal ?? principal(),
    } as unknown as RuntimeRouteContext).catch((cause) => problem(runtimeApiErrorFromCause(cause)));
    return { body: JSON.parse(result!.body) as Record<string, any>, status: result!.statusCode };
  };
  return { list, logs };
}

const messages = (body: Record<string, any>) =>
  (body.logs as Array<{ message: string }>).map((entry) => entry.message);

describe("GET /v1/runs/:runId/logs", () => {
  test("returns a run's lines in execution order with their correlation", async () => {
    const { list } = await fixture([
      batchInput(2, 0, [line(0, { message: "retry started" })]),
      batchInput(1, 0, [
        line(0, { message: "run claimed" }),
        line(1, {
          attributes: { tool: "lookup" },
          message: "tool started",
          source: "tool",
          spanId: "fedcba9876543210",
          toolCallId,
        }),
      ]),
    ]);

    const { body, status } = await list();

    expect(status).toBe(200);
    expect(messages(body)).toEqual(["run claimed", "tool started", "retry started"]);
    expect(body.logs[1]).toEqual({
      attempt: 1,
      attributes: { tool: "lookup" },
      id: "1-0-1",
      level: "info",
      message: "tool started",
      runId: run.data.id,
      source: "tool",
      spanId: "fedcba9876543210",
      threadId: run.data.threadId,
      time: new Date(now.getTime() + 1_000).toISOString(),
      toolCallId,
      traceId: run.data.traceId,
    });
    expect(typeof body.nextCursor).toBe("string");
  });

  test("pages inside a batch and lets a follower poll the last cursor for new lines", async () => {
    const { list, logs } = await fixture([
      batchInput(1, 0, [line(0), line(1), line(2)]),
      batchInput(1, 1, [line(3)]),
    ]);

    const first = await list({ limit: "2" });
    const second = await list({ cursor: first.body.nextCursor, limit: "2" });
    const caughtUp = await list({ cursor: second.body.nextCursor });
    await logs.appendBatch(batchInput(1, 2, [line(4, { message: "written later" })]));
    const followed = await list({ cursor: caughtUp.body.nextCursor });

    expect(messages(first.body)).toEqual(["line 0", "line 1"]);
    expect(first.body.caughtUp).toBe(false);
    expect(messages(second.body)).toEqual(["line 2", "line 3"]);
    expect(messages(caughtUp.body)).toEqual([]);
    expect(caughtUp.body.caughtUp).toBe(true);
    expect(messages(followed.body)).toEqual(["written later"]);
    expect(followed.body.caughtUp).toBe(true);
  });

  test("filters by minimum level, source, tool call, and time range", async () => {
    const { list } = await fixture([
      batchInput(1, 0, [
        line(0, { level: "debug" }),
        line(1, { level: "warn", source: "model" }),
        line(2, { level: "error", source: "tool", toolCallId }),
        line(3, { level: "info", source: "hosted-code", toolCallId }),
      ]),
    ]);

    expect(messages((await list({ level: "warn" })).body)).toEqual(["line 1", "line 2"]);
    expect(messages((await list({ source: "hosted-code" })).body)).toEqual(["line 3"]);
    expect(messages((await list({ toolCallId })).body)).toEqual(["line 2", "line 3"]);
    expect(
      messages(
        (
          await list({
            from: new Date(now.getTime() + 1_000).toISOString(),
            to: new Date(now.getTime() + 3_000).toISOString(),
          })
        ).body,
      ),
    ).toEqual(["line 1", "line 2"]);
  });

  test("rejects invalid filters and a cursor issued for other filters", async () => {
    const { list } = await fixture([batchInput(1, 0, [line(0), line(1)])]);
    const { body } = await list({ limit: "1", level: "warn" });

    for (const query of [
      { level: "fatal" },
      { source: "kernel" },
      { limit: "501" },
      { from: "yesterday" },
      { from: now.toISOString(), to: now.toISOString() },
      { toolCallId: "not-a-ulid" },
      { cursor: body.nextCursor },
      { cursor: "rac2.tampered.cursor.value" },
    ]) {
      expect((await list(query)).status).toBe(400);
    }
  });

  test("requires runs:read and hides runs outside the caller's environment", async () => {
    const { list } = await fixture([batchInput(1, 0, [line(0)])]);
    const readsThreadsOnly = {
      ...principal(),
      credential: { data: { id: ids[31]!, scopes: ["threads:read"] } },
      serviceAccount: { data: { id: ids[3]!, scopes: ["threads:read"] } },
    } as unknown as RuntimeApiPrincipal;
    const otherEnvironment = {
      ...principal(),
      scope: { environmentId: ids[28]!, organizationId, projectId },
    } as unknown as RuntimeApiPrincipal;

    expect((await list({}, { principal: readsThreadsOnly })).status).toBe(403);
    expect((await list({}, { principal: otherEnvironment })).status).toBe(404);
    expect((await list({}, { runId: ids[21]! })).status).toBe(404);
  });
});
