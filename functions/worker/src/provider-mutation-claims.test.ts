import { describe, expect, test } from "bun:test";
import type {
  DynamoDatabaseService,
  PlatformRecord,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { key } from "@deployments-ai/db";

import {
  createDynamoRuntimeProviderMutationClaimStore,
  RuntimeProviderMutationKnownFailureError,
  RuntimeProviderMutationOutcomeUnknownError,
  type RuntimeProviderMutationClaimInput,
} from "./provider-mutation-claims.ts";

const ids = {
  connectionId: "01J00000000000000000000001" as Ulid,
  environmentId: "01J00000000000000000000002" as Ulid,
  organizationId: "01J00000000000000000000003" as Ulid,
  projectId: "01J00000000000000000000004" as Ulid,
  runId: "01J00000000000000000000005" as Ulid,
  threadId: "01J00000000000000000000007" as Ulid,
  toolCallId: "01J00000000000000000000006" as Ulid,
};

function claimInput(
  overrides: Partial<RuntimeProviderMutationClaimInput> = {},
): RuntimeProviderMutationClaimInput {
  return {
    binding: {
      authorizationFingerprint: "sha256:shopify-account-1:binding-v1",
      connectionId: ids.connectionId,
      externalAccountId: "shopify-account-1",
      toolPlanFingerprint: "sha256:shopify-fulfillment-create:plan-v1",
    },
    effect: "write",
    environmentId: ids.environmentId,
    idempotencyKey: "run-1:shopify.fulfillments.create",
    input: { variables: { fulfillment: { trackingInfo: { number: "1Z" } } } },
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    runId: ids.runId,
    threadId: ids.threadId,
    toolCallId: ids.toolCallId,
    toolName: "shopify.fulfillments.create",
    ...overrides,
  };
}

function recordKey(record: Pick<PlatformRecord, "pk" | "sk">): string {
  return `${record.pk}\u0000${record.sk}`;
}

function inMemoryDatabase(
  options: {
    readonly failDeleteBeforeCommitOnce?: boolean;
    readonly throwAfterPutCommitOnce?: boolean;
  } = {},
) {
  const records = new Map<string, PlatformRecord>();
  let failDeleteBeforeCommit = options.failDeleteBeforeCommitOnce ?? false;
  let throwAfterPutCommit = options.throwAfterPutCommitOnce ?? false;
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {
      throw "not implemented";
    },
    getRecord: async (_table, key) =>
      records.has(`${key.pk}\u0000${key.sk}`)
        ? records.get(`${key.pk}\u0000${key.sk}`)!
        : undefined,
    putRecord: async (record) => {
      const key = recordKey(record);
      if (records.has(key)) throw new Error("ConditionalCheckFailedException");
      records.set(key, record);
      if (throwAfterPutCommit) {
        throwAfterPutCommit = false;
        throw new Error("simulated lost put response");
      }
    },
    queryRecords: async () => {
      throw "not implemented";
    },
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind === "delete") {
          if (records.get(recordKey(operation.record)) !== operation.record) {
            throw new Error("ConditionalCheckFailedException");
          }
          continue;
        }
        if (operation.kind !== "put") throw new Error("unsupported operation");
        if (
          operation.previousRecord &&
          records.get(recordKey(operation.previousRecord)) !== operation.previousRecord
        ) {
          throw new Error("ConditionalCheckFailedException");
        }
      }
      if (failDeleteBeforeCommit && operations.some((operation) => operation.kind === "delete")) {
        failDeleteBeforeCommit = false;
        throw new Error("simulated delete failure");
      }
      for (const operation of operations) {
        if (operation.kind === "put") records.set(recordKey(operation.record), operation.record);
        if (operation.kind === "delete") records.delete(recordKey(operation.record));
      }
    },
  };
  return { database, records };
}

describe("DynamoDB provider mutation claims", () => {
  test("persists success before replaying a mutation result", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database, {
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });
    const first = await store.begin(claimInput());
    expect(first.action).toBe("execute");
    if (first.action !== "execute") throw new Error("Expected a new mutation claim.");

    await store.succeed(first.claim, {
      artifacts: [
        {
          content: "artifact body",
          contentType: "text/plain",
          fileName: "result.txt",
          label: "Provider result",
          type: "report",
          visibility: "private",
        },
      ],
      externalOperationId: "fulfillment-123",
      output: { fulfillmentId: 123, status: "open" },
      outputSummary: "Created fulfillment.",
      status: "completed",
    });

    expect(store.begin(claimInput())).resolves.toEqual({
      action: "replay",
      result: {
        artifacts: [
          {
            content: "artifact body",
            contentType: "text/plain",
            fileName: "result.txt",
            label: "Provider result",
            type: "report",
            visibility: "private",
          },
        ],
        externalOperationId: "fulfillment-123",
        output: { fulfillmentId: 123, status: "open" },
        outputSummary: "Created fulfillment.",
        status: "completed",
      },
    });
  });

  test("persists an awaited delegation's pending result and replays the same handle", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database, {
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });
    const input = claimInput({
      idempotencyKey: "run-1:agent.delegate",
      toolName: "agent.delegate",
    });
    const first = await store.begin(input);
    if (first.action !== "execute") throw new Error("Expected a new mutation claim.");
    const pending = {
      externalOperationId: "01J00000000000000000000007",
      outputSummary: "Waiting for sub-agent keeper run 01J00000000000000000000007.",
      status: "running" as const,
    };

    await store.succeed(first.claim, pending);

    expect(store.begin(input)).resolves.toEqual({
      action: "replay",
      result: { artifacts: [], ...pending },
    });
  });

  test("refuses to persist a running result without its pending operation", async () => {
    const store = createDynamoRuntimeProviderMutationClaimStore(inMemoryDatabase().database, {
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });
    const first = await store.begin(claimInput());
    if (first.action !== "execute") throw new Error("Expected a new mutation claim.");

    expect(store.succeed(first.claim, { status: "running" })).rejects.toThrow(
      "only with its operation",
    );
  });

  test("continues when the initial claim committed before its response was lost", async () => {
    const memory = inMemoryDatabase({ throwAfterPutCommitOnce: true });
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database, {
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    const started = await store.begin(claimInput());

    expect(started.action).toBe("execute");
    expect(memory.records.size).toBe(1);
  });

  test("releases an undispatched claim so the request can be acquired again", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database);
    const first = await store.begin(claimInput());
    if (first.action !== "execute") throw new Error("Expected a new mutation claim.");

    await store.release(first.claim);
    const retried = await store.begin(claimInput());

    expect(retried.action).toBe("execute");
    expect(memory.records.size).toBe(1);
  });

  test("keeps a failed pre-dispatch release retryable without quarantining the claim", async () => {
    const memory = inMemoryDatabase({ failDeleteBeforeCommitOnce: true });
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database);
    const first = await store.begin(claimInput());
    if (first.action !== "execute") throw new Error("Expected a new mutation claim.");

    expect(store.release(first.claim)).rejects.toThrow("simulated delete failure");
    expect([...memory.records.values()][0]).toMatchObject({ data: { status: "releasable" } });
    expect(store.begin(claimInput())).resolves.toMatchObject({ action: "execute" });
    expect([...memory.records.values()][0]).toMatchObject({ data: { status: "active" } });
  });

  test("replays a completed mutation when a reclaimed run gets a new tool-call ID", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database, {
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });
    const first = await store.begin(claimInput());
    if (first.action !== "execute") throw new Error("Expected a new mutation claim.");
    await store.succeed(first.claim, {
      artifacts: [
        {
          content: "artifact body",
          fileName: `${ids.toolCallId}-shopify-response.json`,
          label: "Provider result",
          metadata: { toolCallId: ids.toolCallId, toolName: "shopify.fulfillments.create" },
        },
      ],
      externalOperationId: "fulfillment-123",
      outputSummary: "Created fulfillment.",
      status: "completed",
    });

    expect(
      store.begin(claimInput({ toolCallId: "01J00000000000000000000009" as Ulid })),
    ).resolves.toEqual({
      action: "replay",
      result: {
        artifacts: [
          {
            content: "artifact body",
            fileName: `${ids.toolCallId}-shopify-response.json`,
            label: "Provider result",
            metadata: {
              toolCallId: ids.toolCallId,
              toolName: "shopify.fulfillments.create",
            },
          },
        ],
        externalOperationId: "fulfillment-123",
        outputSummary: "Created fulfillment.",
        status: "completed",
      },
    });
    expect(memory.records.size).toBe(1);
  });

  test("replays a completed claim written with the legacy idempotency-only key", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database);
    const input = claimInput();
    const started = await store.begin(input);
    if (started.action !== "execute") throw new Error("Expected a new mutation claim.");
    await store.succeed(started.claim, {
      outputSummary: "Created fulfillment.",
      status: "completed",
    });
    const canonical = [...memory.records.values()][0]!;
    if (canonical.itemType !== "provider-mutation-claim") {
      throw new Error("Expected a persisted provider mutation claim.");
    }
    memory.records.delete(recordKey(canonical));
    const legacy = {
      ...canonical,
      pk: key("ORG", input.organizationId, "ENV", input.environmentId),
      sk: key("PROVIDER-MUTATION-CLAIM", input.idempotencyKey),
      gsi2sk: key(
        "PROVIDER-MUTATION-CLAIM",
        "succeeded",
        canonical.data.updatedAt,
        input.idempotencyKey,
      ),
    } as PlatformRecord;
    memory.records.set(recordKey(legacy), legacy);

    expect(store.begin(input)).resolves.toEqual({
      action: "replay",
      result: { artifacts: [], outputSummary: "Created fulfillment.", status: "completed" },
    });
    expect(memory.records.size).toBe(1);
  });

  test("ignores a legacy claim from another run", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database);
    const input = claimInput();
    const started = await store.begin(input);
    if (started.action !== "execute") throw new Error("Expected a new mutation claim.");
    const canonical = [...memory.records.values()][0]!;
    if (canonical.itemType !== "provider-mutation-claim") {
      throw new Error("Expected a persisted provider mutation claim.");
    }
    memory.records.delete(recordKey(canonical));
    const legacy = {
      ...canonical,
      pk: key("ORG", input.organizationId, "ENV", input.environmentId),
      sk: key("PROVIDER-MUTATION-CLAIM", input.idempotencyKey),
    } as PlatformRecord;
    memory.records.set(recordKey(legacy), legacy);

    const later = await store.begin(
      claimInput({
        runId: "01J00000000000000000000008" as Ulid,
        toolCallId: "01J00000000000000000000009" as Ulid,
      }),
    );

    expect(later.action).toBe("execute");
    expect(memory.records.size).toBe(2);
  });

  test("transitions an abandoned active legacy claim in place", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database, {
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });
    const input = claimInput();
    const started = await store.begin(input);
    if (started.action !== "execute") throw new Error("Expected a new mutation claim.");
    const canonical = started.claim.record;
    memory.records.delete(recordKey(canonical));
    const legacy = {
      ...canonical,
      gsi1pk: undefined,
      gsi1sk: undefined,
      pk: key("ORG", input.organizationId, "ENV", input.environmentId),
      gsi2sk: key(
        "PROVIDER-MUTATION-CLAIM",
        "active",
        canonical.data.updatedAt,
        input.idempotencyKey,
      ),
      sk: key("PROVIDER-MUTATION-CLAIM", input.idempotencyKey),
    } as PlatformRecord;
    memory.records.set(recordKey(legacy), legacy);

    expect(store.begin(input)).rejects.toBeInstanceOf(RuntimeProviderMutationOutcomeUnknownError);
    expect(memory.records.get(recordKey(legacy))).toMatchObject({
      data: { status: "unknown", version: 1 },
      sk: legacy.sk,
    });
  });

  test("persists worst-case escaped artifacts within the runtime default envelope", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database);
    const started = await store.begin(claimInput());
    if (started.action !== "execute") throw new Error("Expected a new mutation claim.");

    expect(
      store.succeed(started.claim, {
        artifacts: [
          {
            content: "\u0000".repeat(48_000),
            fileName: "provider-response.txt",
            label: "Provider result",
          },
        ],
        status: "completed",
      }),
    ).resolves.toBeUndefined();
  });

  test("turns an abandoned active claim into an unknown outcome without redispatch", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database, {
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });
    await store.begin(claimInput());

    expect(store.begin(claimInput())).rejects.toBeInstanceOf(
      RuntimeProviderMutationOutcomeUnknownError,
    );
    expect(
      [...memory.records.values()].find((record) => record.itemType === "provider-mutation-claim"),
    ).toMatchObject({ data: { status: "unknown", version: 1 } });
  });

  test("replays a persisted known failure without dispatch", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database, {
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });
    const started = await store.begin(claimInput());
    if (started.action !== "execute") throw new Error("Expected a new mutation claim.");
    await store.fail(started.claim, new Error("Provider rejected the request."));

    expect(store.begin(claimInput())).rejects.toBeInstanceOf(
      RuntimeProviderMutationKnownFailureError,
    );
  });

  test("rejects idempotency reuse across provider accounts", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database);
    await store.begin(claimInput());

    expect(
      store.begin(
        claimInput({
          binding: {
            authorizationFingerprint: "sha256:shopify-account-2:binding-v1",
            connectionId: "01J00000000000000000000007" as Ulid,
            externalAccountId: "shopify-account-2",
            toolPlanFingerprint: "sha256:shopify-fulfillment-create:plan-v1",
          },
        }),
      ),
    ).rejects.toThrow("identity does not match");
  });

  test("allows a later run to reuse a release-defined idempotency key", async () => {
    const memory = inMemoryDatabase();
    const store = createDynamoRuntimeProviderMutationClaimStore(memory.database);
    const first = await store.begin(claimInput());
    const second = await store.begin(
      claimInput({
        runId: "01J00000000000000000000008" as Ulid,
        toolCallId: "01J00000000000000000000009" as Ulid,
      }),
    );

    expect(first.action).toBe("execute");
    expect(second.action).toBe("execute");
    expect(memory.records.size).toBe(2);
  });
});
