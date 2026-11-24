import { describe, expect, test } from "bun:test";
import {
  ArtifactRecord,
  ToolCallRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import { PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY } from "@deployments-ai/tools";
import { providerHandoffInputHash } from "./artifact-handoff-runtime.ts";
import {
  createRuntimeArtifactLifecycleBuiltinExecutors,
  type RuntimeArtifactLifecycleOptions,
} from "./artifact-lifecycle-runtime-tools.ts";
import { createRuntimeArtifactHandoffProviderInputPreparer } from "./artifact-handoff-provider-input.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const organizationId = id("01");
const projectId = id("02");
const environmentId = id("03");
const artifactId = id("10");
const sourceToolCallId = id("12");
const handoffIntentId = id("13");
const handoffProvider = "twilio";
const handoffToolName = "twilio.messages.send";
const twilioRecipient = {
  accountSid: "AC00000000000000000000000000000000",
  from: "+15550000001",
  to: "+15550000002",
};
const providerInput = { ...twilioRecipient, body: "Post {{artifact.url}}" };
function fixture(
  options: {
    readonly agentDeploymentId?: Ulid;
    readonly ownerServiceAccountId?: Ulid;
    readonly includeHandoffIntent?: boolean;
    readonly retentionExpiresAt?: string;
    readonly recordVersion?: number;
    readonly runId?: Ulid;
    readonly sourceToolCall?: {
      readonly environmentId?: Ulid;
      readonly organizationId?: Ulid;
      readonly projectId?: Ulid;
      readonly status?: "failed" | "succeeded";
      readonly toolName?: string;
      readonly artifactId?: Ulid;
      readonly input?: Readonly<Record<string, unknown>>;
    };
    readonly visibility?: "organization" | "private";
  } = {},
) {
  const artifact = Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-29T00:00:00.000Z",
        environmentId,
        id: artifactId,
        ...((options.includeHandoffIntent ?? options.sourceToolCall !== undefined)
          ? {
              metadata: {
                providerHandoffIntents: [
                  {
                    artifactId,
                    createdAt: "2026-07-29T00:10:00.000Z",
                    expiresAt: "2026-07-29T02:00:00.000Z",
                    intentId: handoffIntentId,
                    provider: handoffProvider,
                    providerInputHash: providerHandoffInputHash(providerInput),
                    reservedAt: "2026-07-29T00:19:00.000Z",
                    reservedByToolCallId: sourceToolCallId,
                    toolName: handoffToolName,
                  },
                ],
              },
            }
          : {}),
        name: "report",
        organizationId,
        ...(options.agentDeploymentId ? { agentDeploymentId: options.agentDeploymentId } : {}),
        ...(options.ownerServiceAccountId
          ? { owner: { serviceAccountId: options.ownerServiceAccountId, type: "service-account" } }
          : {}),
        projectId,
        ...(options.retentionExpiresAt ? { retentionExpiresAt: options.retentionExpiresAt } : {}),
        runId: options.runId ?? id("07"),
        status: "available",
        storage: {
          bucket: "artifacts",
          byteSize: 6,
          contentType: "text/plain",
          fileName: "report.txt",
          key: "report.txt",
          sha256: "0".repeat(64),
          versionId: "version-1",
        },
        type: "report",
        updatedAt: "2026-07-29T00:00:00.000Z",
        version: options.recordVersion ?? 0,
        visibility: options.visibility ?? "organization",
      },
      itemType: "artifact",
      ...(options.retentionExpiresAt
        ? { ttl: Math.floor(Date.parse(options.retentionExpiresAt) / 1_000) }
        : {}),
    }),
  );
  const recordKey = (record: PlatformRecord) =>
    `${tableForItemType(record.itemType)}\u0000${record.pk}\u0000${record.sk}`;
  const records = new Map([[recordKey(artifact), artifact as PlatformRecord]]);
  if (options.sourceToolCall) {
    const sourceToolCall = Schema.decodeUnknownSync(ToolCallRecord)(
      withCanonicalRecordKeys({
        data: {
          completedAt: "2026-07-29T00:30:00.000Z",
          createdAt: "2026-07-29T00:20:00.000Z",
          effect: "write",
          environmentId: options.sourceToolCall.environmentId ?? environmentId,
          externalOperationId: "message-123",
          id: sourceToolCallId,
          idempotencyKey: "provider-write",
          input: {
            ...(options.sourceToolCall.input ?? providerInput),
            [PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY]: {
              artifactId: options.sourceToolCall.artifactId ?? artifactId,
              contentType: "text/plain",
              fileName: "report.txt",
              intentId: handoffIntentId,
            },
          },
          inputSummary: "post artifact",
          organizationId: options.sourceToolCall.organizationId ?? organizationId,
          outputSummary: "Posted the artifact.",
          policyAction: "require-approval",
          policyReason: "test",
          projectId: options.sourceToolCall.projectId ?? projectId,
          requiredScopes: ["chat:write"],
          runId: id("07"),
          startedAt: "2026-07-29T00:20:00.000Z",
          status: options.sourceToolCall.status ?? "succeeded",
          threadId: id("08"),
          toolName: options.sourceToolCall.toolName ?? handoffToolName,
          updatedAt: "2026-07-29T00:30:00.000Z",
          version: 1,
        },
        itemType: "tool-call",
      }),
    );
    records.set(recordKey(sourceToolCall), sourceToolCall);
  }
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: (table, key) =>
      Promise.resolve(records.get(`${table}\u0000${key.pk}\u0000${key.sk}`)),
    putRecord: async () => {},
    queryRecords: (table) =>
      Promise.resolve({
        items:
          table === "events"
            ? [...records.values()].filter((record) => record.itemType === "semantic-event")
            : [],
      }),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind !== "put" || !operation.previousRecord) continue;
        if (records.get(recordKey(operation.previousRecord)) !== operation.previousRecord) {
          const conflict = new Error("Conditional artifact update");
          conflict.name = "ConditionalCheckFailedException";
          throw conflict;
        }
      }
      for (const operation of operations) {
        if (operation.kind === "put") records.set(recordKey(operation.record), operation.record);
      }
    },
  };
  return { artifact, database, records };
}

const request = {
  agentDefinitionId: id("04"),
  agentDeploymentId: id("05"),
  agentReleaseId: id("06"),
  decision: { action: "allow" as const, reason: "test", toolCallId: id("09") },
  effect: "write" as const,
  environmentId,
  idempotencyKey: "archive",
  input: { artifactId },
  inputSummary: "archive",
  organizationId,
  projectId,
  requiredScopes: [],
  runId: id("07"),
  threadId: id("08"),
  toolName: "artifact.archive",
};
function lifecycle(
  database: DynamoDatabaseService,
  overrides: Partial<Omit<RuntimeArtifactLifecycleOptions, "database">> = {},
) {
  return createRuntimeArtifactLifecycleBuiltinExecutors({
    artifactBucket: "artifacts",
    artifactS3: { send: async () => ({}) } as never,
    database,
    generateId: async () => id("11"),
    ...overrides,
  });
}

describe("artifact lifecycle runtime executors", () => {
  test("reconciles one concurrent archive transition and then replays terminal state", async () => {
    const memory = fixture();
    let generated = 11;
    const executor = createRuntimeArtifactLifecycleBuiltinExecutors({
      artifactBucket: "artifacts",
      artifactS3: { send: async () => ({}) } as never,
      database: memory.database,
      generateId: async () => id(String(generated++).padStart(2, "0")),
      now: () => new Date("2026-07-29T01:00:00.000Z"),
    })["artifact.archive"]!;
    const outcomes = await Promise.allSettled([
      executor(request, {} as never),
      executor(request, {} as never),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    const replay = await executor(request, {} as never);
    expect(replay.outputSummary).toContain("already archived");
  });
  test("continues event versions and preserves retained artifact TTL", async () => {
    const retentionExpiresAt = "2026-07-30T00:00:00.000Z";
    const memory = fixture({ recordVersion: 1, retentionExpiresAt });
    const priorEvent = {
      data: {
        aggregateId: artifactId,
        aggregateType: "artifact",
        aggregateVersion: 1,
        organizationId,
      },
      itemType: "semantic-event",
      pk: "prior",
      sk: "prior",
    } as unknown as PlatformRecord;
    const executor = lifecycle(
      {
        ...memory.database,
        queryRecords: (table) =>
          table === "events"
            ? Promise.resolve({ items: [priorEvent] })
            : Promise.resolve({ items: [] }),
      } as DynamoDatabaseService,
      { now: () => new Date("2026-07-29T00:00:00.000Z") },
    )["artifact.archive"]!;
    await executor(request, {} as never);
    const event = [...memory.records.values()].find(
      (record) => record.itemType === "semantic-event" && record.data.aggregateId === artifactId,
    );
    expect(event?.itemType === "semantic-event" ? event.data.aggregateVersion : undefined).toBe(2);
    const artifact = [...memory.records.values()].find(
      (record) => record.itemType === "artifact" && record.data.id === artifactId,
    );
    expect(artifact?.ttl).toBe(Date.parse(retentionExpiresAt) / 1_000);
  });
  test("does not expose a private artifact owned by another run", async () => {
    const foreignRunId = id("19");
    const memory = fixture({
      agentDeploymentId: request.agentDeploymentId,
      ownerServiceAccountId: id("18"),
      runId: foreignRunId,
      visibility: "private",
    });
    const executor = lifecycle(memory.database)["artifact.inspect"]!;
    expect(
      executor({ ...request, effect: "read", toolName: "artifact.inspect" }, {} as never),
    ).rejects.toThrow("current run scope");
  });
  test("does not archive another agent's organization artifact", async () => {
    const foreignRunId = id("19");
    const memory = fixture({
      agentDeploymentId: id("18"),
      runId: foreignRunId,
    });
    const executor = lifecycle(memory.database)["artifact.archive"]!;
    expect(
      executor({ ...request, input: { artifactId, sourceRunId: foreignRunId } }, {} as never),
    ).rejects.toThrow("current run scope");
  });
  test("retries transient artifact reads before mutation", async () => {
    const memory = fixture();
    const executor = lifecycle({
      ...memory.database,
      getRecord: () => Promise.reject(new Error("DynamoDB unavailable")),
    } as unknown as DynamoDatabaseService)["artifact.archive"]!;
    expect(executor(request, {} as never)).rejects.toBeInstanceOf(
      RuntimeToolPreparationRetryableError,
    );
  });
  test("retries event preparation failures without mutating the artifact", async () => {
    const memory = fixture();
    const executor = lifecycle({
      ...memory.database,
      queryRecords: (table) =>
        table === "events"
          ? Promise.reject(new Error("events unavailable"))
          : Promise.resolve({ items: [] }),
    } as DynamoDatabaseService)["artifact.archive"]!;
    expect(executor(request, {} as never)).rejects.toBeInstanceOf(
      RuntimeToolPreparationRetryableError,
    );
    const artifact = [...memory.records.values()].find(
      (record) => record.itemType === "artifact" && record.data.id === artifactId,
    ) as Extract<PlatformRecord, { readonly itemType: "artifact" }> | undefined;
    expect(artifact?.data).toMatchObject({ status: "available", version: 0 });
  });
  test("does not emit lifecycle semantic events while an artifact remains private", async () => {
    const memory = fixture({ visibility: "private" });
    const executor = lifecycle(memory.database)["artifact.archive"]!;
    await executor(request, {} as never);
    expect(
      [...memory.records.values()].some((record) => record.itemType === "semantic-event"),
    ).toBe(false);
  });
  test("excludes logically expired artifacts from run listings", async () => {
    const memory = fixture({ retentionExpiresAt: "2026-07-29T00:30:00.000Z" });
    const executor = createRuntimeArtifactLifecycleBuiltinExecutors({
      artifactBucket: "artifacts",
      artifactS3: { send: async () => ({}) } as never,
      database: {
        ...memory.database,
        queryRecords: (_table, input) => {
          expect(input).toMatchObject({
            ExpressionAttributeValues: {
              ":pk": `ORG#${organizationId}#RUN#${request.runId}#ARTIFACTS`,
              ":sk": "ARTIFACT#",
            },
            IndexName: "gsi1",
          });
          return Promise.resolve({ items: [memory.artifact] });
        },
      } as DynamoDatabaseService,
      generateId: async () => id("11"),
      now: () => new Date("2026-07-29T01:00:00.000Z"),
    })["artifact.source_run"]!;
    const result = await executor(
      {
        ...request,
        effect: "read",
        input: { sourceRunId: request.runId },
        toolName: "artifact.source_run",
      },
      {} as never,
    );
    expect(JSON.parse(String(result.artifacts?.[0]?.content))).toEqual({ artifacts: [] });
  });
  test("excludes run artifacts from another environment", async () => {
    const memory = fixture();
    const foreign = {
      ...memory.artifact,
      data: { ...memory.artifact.data, environmentId: id("19") },
    } as PlatformRecord;
    const executor = createRuntimeArtifactLifecycleBuiltinExecutors({
      artifactBucket: "artifacts",
      artifactS3: { send: async () => ({}) } as never,
      database: {
        ...memory.database,
        queryRecords: () => Promise.resolve({ items: [foreign] }),
      } as DynamoDatabaseService,
      generateId: async () => id("11"),
    })["artifact.source_run"]!;
    const result = await executor(
      {
        ...request,
        effect: "read",
        input: { sourceRunId: request.runId },
        toolName: "artifact.source_run",
      },
      {} as never,
    );
    expect(JSON.parse(String(result.artifacts?.[0]?.content))).toEqual({ artifacts: [] });
  });

  test("persists a handoff template and mints its URL only at provider dispatch", async () => {
    const memory = fixture();
    let currentTime = new Date("2026-07-29T01:00:00.000Z");
    let signedAt: string | undefined;
    const options: RuntimeArtifactLifecycleOptions = {
      artifactBucket: "artifacts",
      artifactS3: { send: async () => ({}) } as never,
      database: memory.database,
      generateId: async () => id("11"),
      now: () => currentTime,
      signAccessUrl: async (_client, _command, signing) => {
        signedAt =
          signing?.signingDate instanceof Date
            ? signing.signingDate.toISOString()
            : String(signing?.signingDate);
        return `https://artifacts.example/report-${signedAt}.txt`;
      },
    };
    const executor =
      createRuntimeArtifactLifecycleBuiltinExecutors(options)[
        "artifact.provider_handoffs.plan_write"
      ]!;
    const result = await executor(
      {
        ...request,
        effect: "write",
        input: {
          artifactId,
          provider: handoffProvider,
          providerInput,
          toolName: handoffToolName,
        },
        toolName: "artifact.provider_handoffs.plan_write",
      },
      {} as never,
    );
    const value = JSON.parse(String(result.artifacts?.[0]?.content));
    expect(value.input).toMatchObject({
      ...providerInput,
      [PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY]: {
        artifactId,
        intentId: request.decision.toolCallId,
      },
    });
    const current = [...memory.records.values()].find(
      (record) => record.itemType === "artifact" && record.data.id === artifactId,
    ) as Extract<PlatformRecord, { readonly itemType: "artifact" }> | undefined;
    expect(current?.data.metadata?.providerHandoffIntents).toEqual([
      {
        accessExpiresInSeconds: 900,
        artifactId,
        createdAt: "2026-07-29T01:00:00.000Z",
        disposition: "inline",
        expiresAt: "2026-07-30T01:00:00.000Z",
        intentId: request.decision.toolCallId,
        provider: handoffProvider,
        providerInputHash: providerHandoffInputHash(providerInput),
        toolName: handoffToolName,
      },
    ]);
    expect(signedAt).toBeUndefined();
    currentTime = new Date("2026-07-29T02:00:00.000Z");
    const prepared = await createRuntimeArtifactHandoffProviderInputPreparer(options)(
      {
        ...request,
        input: value.input,
        toolName: handoffToolName,
      } as never,
      { provider: handoffProvider, toolName: handoffToolName } as never,
    );
    expect(signedAt).toBe("2026-07-29T02:00:00.000Z");
    const accessed = [...memory.records.values()].find(
      (record) => record.itemType === "artifact" && record.data.id === artifactId,
    );
    expect(accessed?.itemType === "artifact" ? accessed.data.accessUrlExpiresAt : undefined).toBe(
      "2026-07-29T02:15:00.000Z",
    );
    expect(prepared.input).toMatchObject({
      ...twilioRecipient,
      body: "Post https://artifacts.example/report-2026-07-29T02:00:00.000Z.txt",
      [PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY]: {
        artifactId,
        intentId: request.decision.toolCallId,
      },
    });
    expect(prepared.releaseOnRetry).toBeFunction();
    await prepared.releaseOnRetry!();
    expect(
      createRuntimeArtifactHandoffProviderInputPreparer(options)(
        {
          ...request,
          decision: { ...request.decision, toolCallId: id("14") },
          input: value.input,
          toolName: handoffToolName,
        } as never,
        { provider: handoffProvider, toolName: handoffToolName } as never,
      ),
    ).resolves.toMatchObject({ persistCanonicalHandoffResponse: true });
  });

  test("rejects a provider write plan that does not carry the artifact URL", async () => {
    const memory = fixture();
    const executor = lifecycle(memory.database)["artifact.provider_handoffs.plan_write"]!;
    expect(
      executor(
        {
          ...request,
          effect: "write",
          input: {
            artifactId,
            provider: handoffProvider,
            providerInput: { ...twilioRecipient, body: "No artifact here" },
            toolName: handoffToolName,
          },
          toolName: "artifact.provider_handoffs.plan_write",
        },
        {} as never,
      ),
    ).rejects.toThrow("{{artifact.url}}");
  });

  test("records only the canonical succeeded provider tool result", async () => {
    const memory = fixture({ sourceToolCall: {} });
    const executor = lifecycle(memory.database, {
      now: () => new Date("2026-07-29T01:00:00.000Z"),
    })["artifact.provider_handoffs.record_result"]!;
    const result = await executor(
      {
        ...request,
        input: {
          artifactId,
          artifactStatus: "published",
          externalId: "fabricated-id",
          externalStatus: "fabricated-status",
          externalUrl: "https://attacker.example/fabricated",
          handoffIntentId,
          provider: handoffProvider,
          sourceToolCallId,
          toolName: handoffToolName,
        },
        toolName: "artifact.provider_handoffs.record_result",
      },
      {} as never,
    );
    const value = JSON.parse(String(result.artifacts?.[0]?.content));
    expect(value.handoff).toEqual({
      artifactStatus: "approved",
      externalId: "message-123",
      externalStatus: "succeeded",
      handoffIntentId,
      outputSummary: "Posted the artifact.",
      provider: handoffProvider,
      recordedAt: "2026-07-29T01:00:00.000Z",
      sourceToolCallId,
      toolName: handoffToolName,
    });
    const replay = await executor(
      {
        ...request,
        input: {
          artifactId,
          handoffIntentId,
          provider: handoffProvider,
          sourceToolCallId,
          toolName: handoffToolName,
        },
        toolName: "artifact.provider_handoffs.record_result",
      },
      {} as never,
    );
    expect(JSON.parse(String(replay.artifacts?.[0]?.content)).handoff).toEqual(value.handoff);
    const current = [...memory.records.values()].find(
      (record) => record.itemType === "artifact" && record.data.id === artifactId,
    ) as Extract<PlatformRecord, { readonly itemType: "artifact" }> | undefined;
    expect(current?.data.version).toBe(1);
  });

  test.each([
    ["another artifact", { artifactId: id("19") }, "different artifact handoff"],
    [
      "different input",
      { input: { ...providerInput, body: "A different message" } },
      "input does not match",
    ],
  ])("rejects a provider call bound to %s", async (_case, sourceToolCall, message) => {
    const memory = fixture({ sourceToolCall });
    const executor = lifecycle(memory.database)["artifact.provider_handoffs.record_result"]!;
    expect(
      executor(
        {
          ...request,
          input: {
            artifactId,
            handoffIntentId,
            provider: handoffProvider,
            sourceToolCallId,
            toolName: handoffToolName,
          },
          toolName: "artifact.provider_handoffs.record_result",
        },
        {} as never,
      ),
    ).rejects.toThrow(message);
  });

  test("keeps the persisted share artifact byte-stable during claim replay", async () => {
    const memory = fixture({ visibility: "private" });
    let currentTime = new Date("2026-07-29T01:00:00.000Z");
    const share = createRuntimeArtifactLifecycleBuiltinExecutors({
      artifactBucket: "artifacts",
      artifactS3: { send: async () => ({}) } as never,
      database: memory.database,
      generateId: async () => id("11"),
      now: () => currentTime,
      signAccessUrl: async (_client, _command, options) =>
        `https://artifacts.example/${
          options?.signingDate instanceof Date
            ? options.signingDate.toISOString()
            : String(options?.signingDate)
        }`,
    })["artifact.share"]!;
    const shareRequest = {
      ...request,
      input: { artifactId, expiresInSeconds: 900 },
      toolName: "artifact.share",
    };
    const initial = await share(shareRequest, {} as never);
    const initialValue = JSON.parse(String(initial.artifacts?.[0]?.content));
    const initialAccess = JSON.parse(String(initial.transientArtifacts?.[0]?.content));
    expect(initialValue).toMatchObject({ artifactId, shared: true });
    expect(initialValue).not.toHaveProperty("url");
    expect(initialAccess.expiresAt).toBe("2026-07-29T01:15:00.000Z");
    const { transientArtifacts: _transientArtifacts, ...persisted } = initial;
    currentTime = new Date("2026-07-29T02:00:00.000Z");
    const replay = await share.refreshReplay!(shareRequest, {} as never, persisted);
    const replayAccess = JSON.parse(String(replay.transientArtifacts?.[0]?.content));
    expect(replay.artifacts).toEqual(initial.artifacts);
    expect(replayAccess.expiresAt).toBe("2026-07-29T02:15:00.000Z");
    expect(replayAccess.url).not.toBe(initialAccess.url);
    const artifact = [...memory.records.values()].find(
      (record) => record.itemType === "artifact" && record.data.id === artifactId,
    );
    expect(artifact?.data).toMatchObject({
      accessUrlExpiresAt: "2026-07-29T02:15:00.000Z",
      version: 2,
      visibility: "organization",
    });
  });

  test("does not commit artifact sharing when URL signing fails", async () => {
    const memory = fixture({ visibility: "private" });
    const share = createRuntimeArtifactLifecycleBuiltinExecutors({
      artifactBucket: "artifacts",
      artifactS3: { send: async () => ({}) } as never,
      database: memory.database,
      generateId: async () => id("11"),
      signAccessUrl: async () => {
        throw new Error("signer unavailable");
      },
    })["artifact.share"]!;
    expect(share(request, {} as never)).rejects.toBeInstanceOf(
      RuntimeToolPreparationRetryableError,
    );
    const artifact = [...memory.records.values()].find(
      (record) => record.itemType === "artifact" && record.data.id === artifactId,
    ) as Extract<PlatformRecord, { readonly itemType: "artifact" }> | undefined;
    expect(artifact?.data).toMatchObject({ version: 0, visibility: "private" });
  });

  test.each([
    ["missing", undefined, "was not found"],
    ["failed", { status: "failed" as const }, "has not succeeded"],
    ["mismatched", { toolName: "sendgrid.email.send" }, "does not match"],
    ["foreign", { organizationId: id("19") }, "current run scope"],
  ])("rejects a %s source provider tool call", async (_case, sourceToolCall, message) => {
    const memory = fixture(sourceToolCall ? { sourceToolCall } : { includeHandoffIntent: true });
    const database =
      _case === "foreign"
        ? {
            ...memory.database,
            getRecord: (table: string, key: { readonly pk: string; readonly sk: string }) => {
              if (key.sk === `TOOL-CALL#${sourceToolCallId}`) {
                const foreign = [...memory.records.values()].find(
                  (record) => record.itemType === "tool-call",
                );
                return Promise.resolve(foreign);
              }
              return memory.database.getRecord(table as never, key);
            },
          }
        : memory.database;
    const executor = createRuntimeArtifactLifecycleBuiltinExecutors({
      artifactBucket: "artifacts",
      artifactS3: { send: async () => ({}) } as never,
      database: database as DynamoDatabaseService,
      generateId: async () => id("11"),
    })["artifact.provider_handoffs.record_result"]!;
    expect(
      executor(
        {
          ...request,
          input: {
            artifactId,
            handoffIntentId,
            provider: handoffProvider,
            sourceToolCallId,
            toolName: handoffToolName,
          },
          toolName: "artifact.provider_handoffs.record_result",
        },
        {} as never,
      ),
    ).rejects.toThrow(message);
  });
});
