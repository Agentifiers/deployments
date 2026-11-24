import type { DynamoDatabaseService, PlatformRecord, Ulid } from "@deployments-ai/db";
import { DatabaseError, makeIdGenerator } from "@deployments-ai/db";
import type { ModelUsageLedgerEntry } from "@deployments-ai/model-gateway";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { modelUsageMeterEvent, makeModelUsageRecorder } from "./index.ts";
const ORG_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const WORKSPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC4" as Ulid;
const OBSERVABILITY = {
  captureMode: "metadata-only" as const,
  runSpanId: "0123456789abcdef" as const,
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid,
  traceId: "0123456789abcdef0123456789abcdef" as const,
};

const entry: ModelUsageLedgerEntry = {
  costUsdNanoDollars: 25_000,
  costUsdMicros: 25,
  idempotencyKey: `${RUN_ID}:model_tokens:bifrost:request:openrouter/z-ai/glm-5.2`,
  inputTokens: 10,
  modelId: "openrouter/z-ai/glm-5.2",
  occurredAt: 1_784_524_800_000,
  outputTokens: 2,
  payer: { kind: "operator" },
  provider: "openrouter",
  quantity: 12,
  runId: RUN_ID,
  source: "bifrost:openrouter/z-ai/glm-5.2",
  startedAt: "2026-07-20T00:00:00.000Z",
  type: "model_tokens",
  unit: "tokens",
};

const scope = {
  environmentId: ENVIRONMENT_ID,
  organizationId: ORG_ID,
  observability: OBSERVABILITY,
  projectId: PROJECT_ID,
  runId: RUN_ID,
  workspaceId: undefined,
};

function database(overrides: Partial<DynamoDatabaseService> = {}): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: async () => undefined,
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async () => {},
    ...overrides,
  };
}

describe("model usage metering", () => {
  test("converts gateway usage into a canonical DynamoDB meter event", async () => {
    const record = await Effect.runPromise(modelUsageMeterEvent(entry, scope, EVENT_ID));

    expect(record.itemType).toBe("meter-event");
    expect(record.sk).toContain(encodeURIComponent(entry.idempotencyKey));
    expect(record.data.dimensions).toEqual({
      costUsdNanoDollars: 25_000,
      costUsdMicros: 25,
      funding: "operator",
      inputTokens: 10,
      modelId: "openrouter/z-ai/glm-5.2",
      provider: "openrouter",
      outputTokens: 2,
      startedAt: "2026-07-20T00:00:00.000Z",
    });
    expect(record.data).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      idempotencyKey: entry.idempotencyKey,
      metric: "model_tokens",
      organizationId: ORG_ID,
      observability: OBSERVABILITY,
      projectId: PROJECT_ID,
      quantity: 12,
      runId: RUN_ID,
      unit: "tokens",
    });
  });

  test("records the organization credential that paid for organization-funded usage", async () => {
    const record = await Effect.runPromise(
      modelUsageMeterEvent(
        { ...entry, payer: { kind: "organization", modelCredentialId: "credential-7" } },
        scope,
        EVENT_ID,
      ),
    );

    expect(record.data.dimensions).toMatchObject({
      funding: "organization",
      modelCredentialId: "credential-7",
    });
  });

  test("attributes non-run model work to its workspace without creating a synthetic run", async () => {
    const operationId = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
    const operationEntry = {
      ...entry,
      idempotencyKey: `${operationId}:model_tokens:bifrost:memory-index:openai/text-embedding-3-small`,
      runId: operationId,
    };
    const record = await Effect.runPromise(
      modelUsageMeterEvent(
        operationEntry,
        {
          environmentId: ENVIRONMENT_ID,
          operationId,
          operationType: "memory-index",
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          workspaceId: WORKSPACE_ID,
        },
        EVENT_ID,
      ),
    );

    expect(record.data.runId).toBeUndefined();
    expect(record.data.workspaceId).toBe(WORKSPACE_ID);
    expect(record.data.dimensions).toMatchObject({
      operationId,
      operationType: "memory-index",
    });
  });

  test("records usage through the shared database boundary", async () => {
    const writes: PlatformRecord[] = [];
    const recorder = makeModelUsageRecorder(
      database({
        putRecord: async (record) => {
          writes.push(record);
        },
      }),
      makeIdGenerator(() => EVENT_ID),
    );

    const result = await Effect.runPromise(recorder.record(entry, scope));

    expect(result.status).toBe("recorded");
    expect(writes).toHaveLength(1);
  });

  test("treats an exact conditional-write replay as an idempotent duplicate", async () => {
    const existing = await Effect.runPromise(modelUsageMeterEvent(entry, scope, EVENT_ID));
    const conditional = new DatabaseError({
      cause: { name: "ConditionalCheckFailedException" },
      message: "conditional",
      operation: "put",
      table: "usage",
    });
    const recorder = makeModelUsageRecorder(
      database({
        getRecord: async () => existing,
        putRecord: () => Promise.reject(conditional),
      }),
      makeIdGenerator(() => "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid),
    );

    const result = await Effect.runPromise(recorder.record(entry, scope));

    expect(result).toEqual({ record: existing, status: "duplicate" });
  });

  test("rejects an idempotency key collision with different usage", async () => {
    const existing = await Effect.runPromise(
      modelUsageMeterEvent({ ...entry, quantity: 99 }, scope, EVENT_ID),
    );
    const recorder = makeModelUsageRecorder(
      database({
        getRecord: async () => existing,
        putRecord: () =>
          Promise.reject(
            new DatabaseError({
              cause: { name: "ConditionalCheckFailedException" },
              message: "conditional",
              operation: "put",
              table: "usage",
            }),
          ),
      }),
      makeIdGenerator(() => "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid),
    );

    expect(Effect.runPromise(recorder.record(entry, scope))).rejects.toMatchObject({
      _tag: "ModelUsageRecordError",
      idempotencyKey: entry.idempotencyKey,
    });
  });

  test("rejects timestamps that cannot be represented canonically", async () => {
    expect(
      Effect.runPromise(
        modelUsageMeterEvent({ ...entry, occurredAt: "not-a-date" }, scope, EVENT_ID),
      ),
    ).rejects.toMatchObject({
      _tag: "ModelUsageRecordError",
      idempotencyKey: entry.idempotencyKey,
    });
  });

  test("rejects invalid cost micros before writing DynamoDB", async () => {
    expect(
      Effect.runPromise(modelUsageMeterEvent({ ...entry, costUsdMicros: 0.5 }, scope, EVENT_ID)),
    ).rejects.toMatchObject({
      _tag: "ModelUsageRecordError",
      message: "Model usage costUsdMicros must be a non-negative safe integer.",
    });
  });

  test("rejects invalid exact nanodollar cost before writing DynamoDB", async () => {
    expect(
      Effect.runPromise(
        modelUsageMeterEvent({ ...entry, costUsdNanoDollars: 0.5 }, scope, EVENT_ID),
      ),
    ).rejects.toMatchObject({
      _tag: "ModelUsageRecordError",
      message: "Model usage costUsdNanoDollars must be a non-negative safe integer.",
    });
  });

  test("rejects fractional token quantities before writing DynamoDB", async () => {
    expect(
      Effect.runPromise(modelUsageMeterEvent({ ...entry, quantity: 0.5 }, scope, EVENT_ID)),
    ).rejects.toMatchObject({
      _tag: "ModelUsageRecordError",
      message: "Model usage quantity must be a non-negative safe integer.",
    });
  });

  test("rejects usage persisted under a different run", async () => {
    expect(
      Effect.runPromise(
        modelUsageMeterEvent(
          entry,
          { ...scope, runId: "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid },
          EVENT_ID,
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "ModelUsageRecordError",
      message: "Model usage attribution must match the persistence scope.",
    });
  });
});
