import { describe, expect, test } from "bun:test";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import {
  ConversationCheckpointRecord,
  ExecutionBindingRecord,
  IdempotencyRecord,
  ModelInvocationRecord,
  RunRecord,
  ThreadRecord,
  activeExecutionBindingCondition,
  executionBindingIdempotencyKey,
  executionBindingIsActive,
  makeDynamoDatabase,
  makeExecutionBindingPersistence,
  makeSemanticEventRecord,
  withCanonicalRecordKeys,
  type ExecutionBindingRecordValue,
  type TransactionOperation,
  type Ulid,
} from "../index.ts";

const ids = Array.from(
  { length: 40 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}` as Ulid,
);
const organizationId = ids[0]!;
const projectId = ids[1]!;
const environmentId = ids[2]!;
const creatorId = ids[3]!;
const createdAt = "2026-07-23T12:00:00.000Z";
const expiresAt = "2026-07-24T12:00:00.000Z";

const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
  apiVersion: "agents.deployments.ai/v1",
  kind: "Agent",
  metadata: { key: "binding.test-agent", name: "Binding Test Agent", version: "1.0.0" },
  spec: {
    instructions: "Answer the preview request.",
    model: { id: "openrouter/test" },
    sandbox: { mode: "none" },
  },
});

function ttl(timestamp: string) {
  return Math.floor(Date.parse(timestamp) / 1_000);
}

function bindingData(id: Ulid, overrides: Record<string, unknown> = {}) {
  return {
    contentHash: agentManifestContentHash(manifest),
    createdAt,
    createdBy: { id: creatorId, type: "principal" as const },
    environmentId,
    expiresAt,
    id,
    idempotencyKey: "preview-1",
    manifest,
    organizationId,
    projectId,
    purpose: "preview" as const,
    source: { type: "manifest" as const },
    status: "active" as const,
    toolPolicy: "interactive" as const,
    updatedAt: createdAt,
    version: 0,
    ...overrides,
  };
}

function binding(id: Ulid, overrides: Record<string, unknown> = {}): ExecutionBindingRecordValue {
  const data = bindingData(id, overrides);
  return Schema.decodeUnknownSync(ExecutionBindingRecord)(
    withCanonicalRecordKeys({
      data,
      itemType: "execution-binding" as const,
      ttl: ttl(String(data.expiresAt)),
    }),
  );
}

const claimKey = executionBindingIdempotencyKey(
  { environmentId, organizationId, principalId: creatorId, projectId },
  "preview-1",
);

function claim(resourceId: Ulid, claimCreatedAt: string, claimExpiresAt: string) {
  return Schema.decodeUnknownSync(IdempotencyRecord)(
    withCanonicalRecordKeys({
      data: {
        commandHash: `command-${resourceId}`,
        createdAt: claimCreatedAt,
        expiresAt: claimExpiresAt,
        idempotencyKey: claimKey,
        organizationId,
        resourceIds: [resourceId],
        status: "completed" as const,
        version: 0,
      },
      itemType: "idempotency" as const,
      ttl: ttl(claimExpiresAt),
    }),
  );
}

function event(aggregateId: Ulid, eventId: Ulid, version: number, eventType: string) {
  return makeSemanticEventRecord({
    aggregateId,
    aggregateType: "execution-binding",
    aggregateVersion: version,
    environmentId,
    eventId,
    eventType,
    occurredAt: new Date(createdAt),
    organizationId,
    payload: {},
    projectId,
  });
}

// ---------------------------------------------------------------------------------------------
// Minimal DynamoDB document client: stores items and evaluates the condition expressions the
// real database adapter generates, applying a transaction only when every condition holds.
// ---------------------------------------------------------------------------------------------

type Item = Readonly<Record<string, unknown>>;

interface ExpressionContext {
  readonly item: Item | undefined;
  readonly names: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, unknown>>;
}

function tokenize(expression: string): string[] {
  const tokens = expression.match(
    /<>|<=|>=|[()=<>,]|[#:]?[A-Za-z_][A-Za-z0-9_]*(?:\.[#]?[A-Za-z_][A-Za-z0-9_]*)*/g,
  );
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) {
    throw new Error(`Unsupported condition expression: ${expression}`);
  }
  return tokens;
}

function evaluate(expression: string, context: ExpressionContext): boolean {
  const tokens = tokenize(expression);
  let index = 0;
  const peek = () => tokens[index];
  const take = (expected?: string) => {
    const token = tokens[index++];
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`Unexpected token ${token} in ${expression}`);
    }
    return token;
  };
  const resolvePath = (path: string): unknown => {
    let value: unknown = context.item;
    for (const segment of path.split(".")) {
      const name = segment.startsWith("#") ? context.names[segment] : segment;
      if (name === undefined) throw new Error(`Unknown attribute name ${segment}`);
      value =
        value !== null && typeof value === "object"
          ? (value as Readonly<Record<string, unknown>>)[name]
          : undefined;
    }
    return value;
  };
  const operand = (token: string): unknown => {
    if (token.startsWith(":")) {
      if (!(token in context.values)) throw new Error(`Unknown attribute value ${token}`);
      return context.values[token];
    }
    return resolvePath(token);
  };
  const compare = (left: unknown, operator: string, right: unknown): boolean => {
    if (left === undefined || right === undefined) return operator === "<>";
    if (operator === "=") return left === right;
    if (operator === "<>") return left !== right;
    if (typeof left !== typeof right) return false;
    const [a, b] = [left as string | number, right as string | number];
    if (operator === "<") return a < b;
    if (operator === "<=") return a <= b;
    if (operator === ">") return a > b;
    if (operator === ">=") return a >= b;
    throw new Error(`Unsupported operator ${operator}`);
  };
  const primary = (): boolean => {
    const token = take();
    if (token === "(") {
      const value = disjunction();
      take(")");
      return value;
    }
    if (token === "NOT") return !primary();
    if (token === "attribute_exists" || token === "attribute_not_exists") {
      take("(");
      const exists = resolvePath(take()) !== undefined;
      take(")");
      return token === "attribute_exists" ? exists : !exists;
    }
    const operator = take();
    return compare(operand(token), operator, operand(take()));
  };
  const conjunction = (): boolean => {
    let value = primary();
    while (peek() === "AND") {
      take();
      value = primary() && value;
    }
    return value;
  };
  const disjunction = (): boolean => {
    let value = conjunction();
    while (peek() === "OR") {
      take();
      value = conjunction() || value;
    }
    return value;
  };
  const result = disjunction();
  if (index !== tokens.length) throw new Error(`Trailing tokens in ${expression}`);
  return result;
}

interface ConditionedCommand {
  readonly ConditionExpression?: string;
  readonly ExpressionAttributeNames?: Record<string, string>;
  readonly ExpressionAttributeValues?: Record<string, unknown>;
  readonly TableName?: string;
}

function conditionalDynamo() {
  const tables = new Map<string, Map<string, Item>>();
  const transactions: TransactWriteCommand["input"][] = [];
  const table = (name: string | undefined) => {
    const key = name ?? "";
    if (!tables.has(key)) tables.set(key, new Map());
    return tables.get(key)!;
  };
  const itemKey = (key: Item) => `${String(key.pk)}\u0000${String(key.sk)}`;
  const holds = (command: ConditionedCommand, item: Item | undefined) =>
    command.ConditionExpression === undefined ||
    evaluate(command.ConditionExpression, {
      item,
      names: command.ExpressionAttributeNames ?? {},
      values: command.ExpressionAttributeValues ?? {},
    });
  // The adapter fences tenant writes on one of the organization's gate lanes.
  for (let lane = 0; lane < 32; lane += 1) {
    const laneKey = {
      pk: `ORG#${organizationId}`,
      sk: `ORGANIZATION-GATE-LANE#${String(lane).padStart(2, "0")}`,
    };
    table("control").set(itemKey(laneKey), {
      ...laneKey,
      data: { memoryProviderGates: {}, organization: { status: "active" }, organizationId },
      itemType: "organization-gate-lane",
    });
  }
  const client = {
    send: async (command: unknown) => {
      if (command instanceof GetCommand) {
        return { Item: table(command.input.TableName).get(itemKey(command.input.Key ?? {})) };
      }
      if (command instanceof TransactWriteCommand) {
        transactions.push(command.input);
        const items = command.input.TransactItems ?? [];
        const reasons = items.map((entry) => {
          const operation = (entry.Put ?? entry.Delete ?? entry.ConditionCheck ?? entry.Update) as
            | (ConditionedCommand & { readonly Item?: Item; readonly Key?: Item })
            | undefined;
          if (!operation || entry.Update) throw new Error("Unsupported transaction item.");
          const key = operation.Item ?? operation.Key ?? {};
          return holds(operation, table(operation.TableName).get(itemKey(key)))
            ? { Code: "None" }
            : { Code: "ConditionalCheckFailed" };
        });
        if (reasons.some((reason) => reason.Code !== "None")) {
          throw Object.assign(new Error("Transaction cancelled"), {
            CancellationReasons: reasons,
            name: "TransactionCanceledException",
          });
        }
        for (const entry of items) {
          if (entry.Put)
            table(entry.Put.TableName).set(itemKey(entry.Put.Item ?? {}), entry.Put.Item!);
          if (entry.Delete) table(entry.Delete.TableName).delete(itemKey(entry.Delete.Key ?? {}));
        }
        return {};
      }
      throw new Error(`Unsupported command ${String((command as object).constructor.name)}`);
    },
  };
  const database = makeDynamoDatabase(client as never);
  return { database, tables, transactions };
}

function createInput(
  record: ExecutionBindingRecordValue,
  idempotency = claim(record.data.id, createdAt, expiresAt),
) {
  return {
    binding: record,
    event: event(record.data.id, ids[30]!, 1, "execution-binding.created"),
    hostedCodeTools: [],
    idempotency,
    transactionToken: `create-${record.data.id}`,
  };
}

function boundTurnOperations(threadId: Ulid): TransactionOperation[] {
  const thread = Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        archived: false,
        channel: "preview",
        createdAt,
        createdBy: { id: creatorId, type: "principal" as const },
        environmentId,
        executionBindingId: ids[10]!,
        executionPurpose: "preview" as const,
        id: threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[20]!,
        title: "Preview",
        updatedAt: createdAt,
        version: 0,
      },
      itemType: "thread" as const,
    }),
  );
  return [{ kind: "put", record: thread }];
}

describe("execution binding persistence", () => {
  test("creates the binding, its idempotency claim, and its event in one transaction", async () => {
    const dynamo = conditionalDynamo();
    const persistence = makeExecutionBindingPersistence(dynamo.database);
    const created = binding(ids[10]!);

    expect(persistence.create(createInput(created))).resolves.toBe(true);

    expect(dynamo.transactions).toHaveLength(1);
    const itemTypes = (dynamo.transactions[0]!.TransactItems ?? []).map(
      (entry) => entry.Put?.Item?.itemType,
    );
    expect(itemTypes).toEqual(
      expect.arrayContaining(["execution-binding", "idempotency", "semantic-event"]),
    );
    expect(
      persistence.get({ environmentId, executionBindingId: ids[10]!, organizationId }),
    ).resolves.toMatchObject({ data: { id: ids[10], status: "active", version: 0 } });
    expect(persistence.getIdempotency(organizationId, claimKey)).resolves.toMatchObject({
      data: { resourceIds: [ids[10]] },
    });
  });

  test("a live idempotency claim rejects a competing binding without persisting it", async () => {
    const dynamo = conditionalDynamo();
    const persistence = makeExecutionBindingPersistence(dynamo.database);
    await persistence.create(createInput(binding(ids[10]!)));

    const competing = binding(ids[11]!, {
      createdAt: "2026-07-23T13:00:00.000Z",
      updatedAt: "2026-07-23T13:00:00.000Z",
    });
    expect(
      persistence.create(
        createInput(competing, claim(ids[11]!, "2026-07-23T13:00:00.000Z", expiresAt)),
      ),
    ).resolves.toBe(false);

    expect(
      persistence.get({ environmentId, executionBindingId: ids[11]!, organizationId }),
    ).resolves.toBeUndefined();
    expect(persistence.getIdempotency(organizationId, claimKey)).resolves.toMatchObject({
      data: { resourceIds: [ids[10]] },
    });
  });

  test("an expired idempotency claim is replaced by the next binding", async () => {
    const dynamo = conditionalDynamo();
    const persistence = makeExecutionBindingPersistence(dynamo.database);
    const first = binding(ids[10]!, { expiresAt: "2026-07-23T12:05:00.000Z" });
    await persistence.create(createInput(first, claim(ids[10]!, createdAt, first.data.expiresAt)));

    const laterAt = "2026-07-23T12:05:00.000Z";
    const later = binding(ids[11]!, {
      createdAt: laterAt,
      expiresAt: "2026-07-24T12:05:00.000Z",
      updatedAt: laterAt,
    });
    expect(
      persistence.create(createInput(later, claim(ids[11]!, laterAt, "2026-07-24T12:05:00.000Z"))),
    ).resolves.toBe(true);
    expect(persistence.getIdempotency(organizationId, claimKey)).resolves.toMatchObject({
      data: { resourceIds: [ids[11]] },
    });
  });

  test("scopes idempotency keys to the creating principal", () => {
    const scope = { environmentId, organizationId, projectId };
    expect(executionBindingIdempotencyKey({ ...scope, principalId: creatorId }, "k")).toBe(
      executionBindingIdempotencyKey({ ...scope, principalId: creatorId }, "k"),
    );
    expect(executionBindingIdempotencyKey({ ...scope, principalId: creatorId }, "k")).not.toBe(
      executionBindingIdempotencyKey({ ...scope, principalId: ids[4]! }, "k"),
    );
  });

  test("expiry bumps the version and fences bound turns on the stale snapshot", async () => {
    const dynamo = conditionalDynamo();
    const persistence = makeExecutionBindingPersistence(dynamo.database);
    const active = binding(ids[10]!);
    await persistence.create(createInput(active));
    const at = new Date("2026-07-23T12:30:00.000Z");

    const expiredAt = at.toISOString();
    const expired = binding(ids[10]!, {
      expiredAt,
      status: "expired",
      updatedAt: expiredAt,
      version: 1,
    });
    expect(
      persistence.expire({
        event: event(ids[10]!, ids[31]!, 2, "execution-binding.expired"),
        expired,
        previous: active,
        transactionToken: "expire",
      }),
    ).resolves.toBe(true);
    expect(
      persistence.get({ environmentId, executionBindingId: ids[10]!, organizationId }),
    ).resolves.toMatchObject({ data: { status: "expired", version: 1 } });

    expect(
      persistence.expire({
        event: event(ids[10]!, ids[32]!, 2, "execution-binding.expired"),
        expired,
        previous: active,
        transactionToken: "expire-again",
      }),
    ).resolves.toBe(false);
    for (const snapshot of [active, expired]) {
      expect(
        persistence.commitBoundTurn({
          at,
          binding: snapshot,
          events: [],
          operations: boundTurnOperations(ids[12]!),
        }),
      ).resolves.toBe(false);
    }
    expect(
      persistence.get({ environmentId, executionBindingId: ids[10]!, organizationId }),
    ).resolves.toMatchObject({ data: { version: 1 } });
    expect(
      [...(dynamo.tables.get("execution")?.values() ?? [])].some(
        (item) => item.itemType === "thread",
      ),
    ).toBe(false);
  });

  test("bound turns commit while active and fail after logical expiry without a status write", async () => {
    const dynamo = conditionalDynamo();
    const persistence = makeExecutionBindingPersistence(dynamo.database);
    const active = binding(ids[10]!);
    await persistence.create(createInput(active));

    const before = new Date("2026-07-24T11:59:59.999Z");
    const after = new Date(expiresAt);
    expect(executionBindingIsActive(active, before)).toBe(true);
    expect(executionBindingIsActive(active, after)).toBe(false);
    expect(activeExecutionBindingCondition(active, after)).toMatchObject({
      expressionAttributeValues: { ":now": expiresAt, ":version": 0 },
      kind: "condition-check",
    });

    expect(
      persistence.commitBoundTurn({
        at: after,
        binding: active,
        events: [],
        operations: boundTurnOperations(ids[12]!),
      }),
    ).resolves.toBe(false);
    expect(
      persistence.commitBoundTurn({
        at: before,
        binding: active,
        events: [],
        operations: boundTurnOperations(ids[13]!),
      }),
    ).resolves.toBe(true);
  });
});

describe("execution binding records", () => {
  test("reject a content hash that does not match the manifest", () => {
    expect(() => binding(ids[10]!, { contentHash: "sha256:not-the-manifest" })).toThrow();
    expect(() => binding(ids[10]!)).not.toThrow();
  });

  test("require expiredAt exactly when expired and expiresAt after createdAt", () => {
    expect(() => binding(ids[10]!, { status: "expired" })).toThrow();
    expect(() => binding(ids[10]!, { expiredAt: createdAt })).toThrow();
    expect(() => binding(ids[10]!, { expiresAt: createdAt })).toThrow();
  });
});

describe("purpose-split execution pins", () => {
  const customer = { agentDeploymentId: ids[5]!, agentReleaseId: ids[6]! };
  const bound = { executionBindingId: ids[10]!, executionPurpose: "preview" as const };
  const mixed = [
    { ...customer, executionBindingId: ids[10]! },
    { ...customer, executionPurpose: "preview" as const },
    { ...customer, ...bound },
    { executionBindingId: ids[10]! },
    { executionBindingId: ids[10]!, executionPurpose: "customer" as const },
    { executionPurpose: "evaluation" as const },
  ];

  const runData = {
    attempt: 0,
    captureMode: "metadata-only" as const,
    createdAt,
    environmentId,
    executor: "hosted",
    id: ids[14]!,
    idempotencyKey: "run/request-1",
    organizationId,
    priority: 1,
    projectId,
    redactionPolicyVersion: 1 as const,
    schemaVersion: 1 as const,
    spanId: "0123456789abcdef",
    status: "queued" as const,
    threadId: ids[12]!,
    trigger: "api",
    traceId: "0123456789abcdef0123456789abcdef",
    updatedAt: createdAt,
    version: 0,
  };
  const checkpointData = {
    contentHash: "checkpoint",
    createdAt,
    environmentId,
    fromSequence: 0,
    id: ids[15]!,
    organizationId,
    projectId,
    runId: ids[14]!,
    sourceMessageCount: 1,
    summary: "Summary.",
    threadId: ids[12]!,
    throughSequence: 0,
  };
  const invocationData = {
    agentDefinitionId: ids[7]!,
    agentManifestHash: agentManifestContentHash(manifest),
    attemptId: "attempt-1",
    captureMode: "metadata-only" as const,
    completedAt: "2026-07-23T12:00:02.000Z",
    createdAt,
    currency: "USD" as const,
    environmentId,
    fallbackAttempt: 0,
    id: ids[16]!,
    internalEvaluator: false,
    invocationId: "invocation-1",
    organizationId,
    parentSpanId: "0123456789abcdef",
    persistedAt: "2026-07-23T12:00:02.000Z",
    projectId,
    redactionPolicyVersion: 1 as const,
    requestedModelId: "openrouter/test",
    runAttempt: 0,
    runExecutionVersion: 1,
    runId: ids[14]!,
    schemaVersion: 1 as const,
    spanId: "1123456789abcdef",
    startedAt: "2026-07-23T12:00:01.000Z",
    status: "succeeded" as const,
    streaming: false,
    threadId: ids[12]!,
    traceId: "0123456789abcdef0123456789abcdef",
    updatedAt: "2026-07-23T12:00:02.000Z",
    version: 0,
  };

  const cases = [
    {
      decode: (data: Readonly<Record<string, unknown>>) =>
        Schema.decodeUnknownSync(RunRecord)(withCanonicalRecordKeys({ data, itemType: "run" })),
      label: "run",
      base: runData,
      boundExtra: { trigger: "preview" },
    },
    {
      decode: (data: Readonly<Record<string, unknown>>) =>
        Schema.decodeUnknownSync(ConversationCheckpointRecord)(
          withCanonicalRecordKeys({ data, itemType: "conversation-checkpoint" }),
        ),
      label: "conversation checkpoint",
      base: checkpointData,
      boundExtra: {},
    },
    {
      decode: (data: Readonly<Record<string, unknown>>) =>
        Schema.decodeUnknownSync(ModelInvocationRecord)(
          withCanonicalRecordKeys({ data, itemType: "model-invocation" }),
        ),
      label: "model invocation",
      base: invocationData,
      boundExtra: {},
    },
  ] as const;

  for (const { base, boundExtra, decode, label } of cases) {
    test(`${label} accepts exactly one pin family`, () => {
      const customerPins =
        label === "conversation checkpoint" ? { agentDeploymentId: ids[5]! } : customer;
      expect(() => decode({ ...base, ...customerPins })).not.toThrow();
      expect(() => decode({ ...base, ...boundExtra, ...bound })).not.toThrow();
      expect(() =>
        decode({ ...base, ...boundExtra, ...bound, executionPurpose: "evaluation" }),
      ).not.toThrow();
      for (const pins of mixed) {
        expect(() => decode({ ...base, ...boundExtra, ...pins })).toThrow();
      }
    });
  }

  test("customer runs and model invocations still require the release pin", () => {
    expect(() => cases[0].decode({ ...runData, agentDeploymentId: ids[5]! })).toThrow();
    expect(() => cases[2].decode({ ...invocationData, agentDeploymentId: ids[5]! })).toThrow();
  });
});
