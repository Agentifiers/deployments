import { marshall } from "@aws-sdk/util-dynamodb";
import {
  BudgetRecord,
  MeterEventRecord,
  RunLocatorRecord,
  RunRecord,
  TraceRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { makeTenancyTestDatabase } from "@deployments-ai/db/memory-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { fixtures, id, inMemoryDatabase } from "./agent-run.fixture.ts";
import { runtimeUsageRecord } from "./records.ts";
import {
  handler,
  meterEventStreamFailureIdentifier,
  setUsageMaterializerDatabaseForTest,
} from "./usage-main.ts";

const INSTALL_ENVIRONMENT = {
  DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify({
    active_sandboxes: 8,
    api_request_burst: 40,
    api_requests_per_second: 20,
    concurrent_runs: 8,
  }),
};

describe("usage stream partial failures", () => {
  test("uses the DynamoDB stream sequence number as the batch item identifier", () => {
    expect(
      meterEventStreamFailureIdentifier({
        dynamodb: { SequenceNumber: "123456789" },
        eventID: "event-id-is-not-a-checkpoint",
      }),
    ).toBe("123456789");
    expect(() => meterEventStreamFailureIdentifier({ eventID: "event-only" })).toThrow(
      "sequence number",
    );
  });

  test("reconciles finalized trace totals and the run agent's counters after materializing model usage", async () => {
    const { release, run: source } = fixtures();
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...source,
        data: {
          ...source.data,
          completedAt: "2026-07-22T00:00:02.000Z",
          status: "completed" as const,
          updatedAt: "2026-07-22T00:00:02.000Z",
          version: 2,
        },
      }),
    );
    const trace = Schema.decodeUnknownSync(TraceRecord)(
      withCanonicalRecordKeys({
        data: {
          captureMode: run.data.captureMode,
          completedAt: run.data.completedAt,
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          finalizedAt: "2026-07-22T00:00:03.000Z",
          graphWatermark: `sha256:${"a".repeat(64)}`,
          id: run.data.traceId,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          redactionPolicyVersion: 1,
          rootRunId: run.data.id,
          rootSpanId: run.data.spanId,
          runIds: [run.data.id],
          schemaVersion: 1,
          sessionId: run.data.threadId,
          status: "finalized" as const,
          terminalRunIds: [run.data.id],
          totalCostUsdMicros: 0,
          totalTokens: 0,
          traceId: run.data.traceId,
          updatedAt: "2026-07-22T00:00:03.000Z",
          version: 2,
          workspaceId: run.data.workspaceId,
        },
        itemType: "trace",
      }),
    );
    const locator = Schema.decodeUnknownSync(RunLocatorRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          id: run.data.id,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          runPk: run.pk,
          runSk: run.sk,
        },
        itemType: "run-locator",
      }),
    );
    const usage = runtimeUsageRecord({
      entry: {
        costUsdMicros: 29,
        idempotencyKey: "memory-rerank:usage-consumer",
        modelId: "openai/gpt-4o-mini",
        occurredAt: "2026-07-22T00:00:04.000Z",
        provider: "bifrost",
        quantity: 41,
        runId: run.data.id,
        source: "memory-rerank",
        payer: { kind: "operator" as const },
        type: "model_tokens",
        unit: "tokens",
      },
      id: id(82),
      run,
    });
    const secondUsage = runtimeUsageRecord({
      entry: {
        costUsdMicros: 2,
        idempotencyKey: "memory-flush:usage-consumer",
        modelId: "openai/gpt-4o-mini",
        occurredAt: "2026-07-22T00:00:05.000Z",
        provider: "bifrost",
        quantity: 3,
        runId: run.data.id,
        source: "memory-flush",
        payer: { kind: "operator" as const },
        type: "model_tokens",
        unit: "tokens",
      },
      id: id(83),
      run,
    });
    const memory = inMemoryDatabase([run, trace, locator, release, usage, secondUsage]);
    setUsageMaterializerDatabaseForTest(memory.database, INSTALL_ENVIRONMENT);

    const result = await handler({
      Records: [
        {
          dynamodb: {
            NewImage: marshall(usage, { removeUndefinedValues: true }),
            SequenceNumber: "123456790",
          },
          eventName: "INSERT",
        },
        {
          dynamodb: {
            NewImage: marshall(secondUsage, { removeUndefinedValues: true }),
            SequenceNumber: "123456791",
          },
          eventName: "INSERT",
        },
      ],
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "trace" && record.data.traceId === run.data.traceId,
      )?.data,
    ).toMatchObject({
      status: "finalized",
      totalCostUsdMicros: 31,
      totalTokens: 44,
      version: 3,
    });
    expect(
      memory.queryInputs.filter((input) => {
        const prefix = (
          input as { readonly ExpressionAttributeValues?: Readonly<Record<string, unknown>> }
        ).ExpressionAttributeValues?.[":prefix"];
        return typeof prefix === "string" && prefix.startsWith("METER-EVENT#");
      }),
    ).toHaveLength(1);
    // The run's release names its agent definition and the run its workspace; each one's
    // counters hold both events.
    const tokensByAttribution = new Map<string, number>();
    for (const record of memory.records.values()) {
      if (record.itemType !== "attributed-usage-counter-shard") continue;
      if (record.data.metric !== "model_tokens") continue;
      const target = `${record.data.attribution}/${record.data.attributionId}`;
      tokensByAttribution.set(
        target,
        (tokensByAttribution.get(target) ?? 0) + record.data.quantity,
      );
    }
    expect(tokensByAttribution).toEqual(
      new Map([
        [`agent/${release.data.agentDefinitionId}`, 44],
        [`workspace/${run.data.workspaceId}`, 44],
      ]),
    );
  });

  test("emits a crossed budget threshold once even when the cost record is redelivered", async () => {
    const { database, records } = makeTenancyTestDatabase();
    const scope = { environmentId: id(41), organizationId: id(42), projectId: id(43) };
    await database.transactWrite([
      {
        kind: "put",
        record: Schema.decodeUnknownSync(BudgetRecord)(
          withCanonicalRecordKeys({
            data: {
              amountUsdMicros: 1_000,
              createdAt: "2026-07-01T00:00:00.000Z",
              id: id(44),
              name: "Org monthly",
              organizationId: scope.organizationId,
              period: "monthly",
              scope: "organization",
              status: "active",
              thresholds: [80],
              updatedAt: "2026-07-01T00:00:00.000Z",
              version: 1,
            },
            itemType: "budget" as const,
          }),
        ),
      },
    ]);
    const usage = Schema.decodeUnknownSync(MeterEventRecord)(
      withCanonicalRecordKeys({
        data: {
          ...scope,
          dimensions: { costUsdMicros: 900 },
          id: id(45),
          idempotencyKey: "budget-cost",
          metric: "sandbox_ms",
          occurredAt: "2026-07-23T12:00:00.000Z",
          quantity: 1_000,
          source: "sandbox",
          unit: "ms",
        },
        itemType: "meter-event" as const,
      }),
    );
    setUsageMaterializerDatabaseForTest(database, INSTALL_ENVIRONMENT);
    const delivery = {
      Records: [
        {
          dynamodb: {
            NewImage: marshall(usage, { removeUndefinedValues: true }),
            SequenceNumber: "223456790",
          },
          eventName: "INSERT",
        },
      ],
    };

    expect(await handler(delivery)).toEqual({ batchItemFailures: [] });
    expect(await handler(delivery)).toEqual({ batchItemFailures: [] });
    expect(
      [...records.values()].flatMap((record) =>
        record.itemType === "semantic-event" && record.data.eventType === "budget.threshold-crossed"
          ? [record.data.payload]
          : [],
      ),
    ).toEqual([expect.objectContaining({ budgetId: id(44), spendUsdMicros: 900, threshold: 80 })]);
  });

  test("emits a workspace budget's crossing with its workspace and not for a sibling's spend", async () => {
    const { database, records } = makeTenancyTestDatabase();
    const scope = { environmentId: id(51), organizationId: id(52), projectId: id(53) };
    const workspaceId = id(54);
    await database.transactWrite([
      {
        kind: "put",
        record: Schema.decodeUnknownSync(BudgetRecord)(
          withCanonicalRecordKeys({
            data: {
              ...scope,
              amountUsdMicros: 1_000,
              createdAt: "2026-07-01T00:00:00.000Z",
              id: id(55),
              name: "Customer monthly",
              period: "monthly",
              scope: "workspace",
              status: "active",
              thresholds: [80],
              updatedAt: "2026-07-01T00:00:00.000Z",
              version: 1,
              workspaceId,
            },
            itemType: "budget" as const,
          }),
        ),
      },
    ]);
    const cost = (eventId: string, eventWorkspaceId: string, sequence: string) => ({
      dynamodb: {
        NewImage: marshall(
          Schema.decodeUnknownSync(MeterEventRecord)(
            withCanonicalRecordKeys({
              data: {
                ...scope,
                dimensions: { costUsdMicros: 900 },
                id: eventId,
                idempotencyKey: `workspace-cost-${eventId}`,
                metric: "sandbox_ms",
                occurredAt: "2026-07-23T12:00:00.000Z",
                quantity: 1_000,
                source: "sandbox",
                unit: "ms",
                workspaceId: eventWorkspaceId,
              },
              itemType: "meter-event" as const,
            }),
          ),
          { removeUndefinedValues: true },
        ),
        SequenceNumber: sequence,
      },
      eventName: "INSERT",
    });
    setUsageMaterializerDatabaseForTest(database, INSTALL_ENVIRONMENT);
    const crossings = () =>
      [...records.values()].flatMap((record) =>
        record.itemType === "semantic-event" && record.data.eventType === "budget.threshold-crossed"
          ? [record.data.payload]
          : [],
      );

    expect(await handler({ Records: [cost(id(56), id(57), "323456790")] })).toEqual({
      batchItemFailures: [],
    });
    expect(crossings()).toEqual([]);
    expect(await handler({ Records: [cost(id(58), workspaceId, "323456791")] })).toEqual({
      batchItemFailures: [],
    });
    expect(crossings()).toEqual([
      expect.objectContaining({
        budgetId: id(55),
        scope: "workspace",
        spendUsdMicros: 900,
        threshold: 80,
        workspaceId,
      }),
    ]);
  });
});
