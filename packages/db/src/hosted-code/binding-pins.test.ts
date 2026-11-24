import { describe, expect, test } from "bun:test";
import { validateAgentManifest } from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import {
  ExecutionBindingRecord,
  HostedCodeArtifactRecord,
  IdempotencyRecord,
  loadExecutionBindingHostedCodeTool,
  makeExecutionBindingPersistence,
  makeSemanticEventRecord,
  makeUniqueClaimRecord,
  ToolAdapterRecord,
  uniqueClaimRequirements,
  UniqueClaimRecord,
  withCanonicalRecordKeys,
  type ExecutionBindingRecordValue,
  type PlatformRecord,
  type Ulid,
} from "../index.ts";

const ids = Array.from(
  { length: 20 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}` as Ulid,
);
const ORGANIZATION_ID = ids[0]!;
const PROJECT_ID = ids[1]!;
const ENVIRONMENT_ID = ids[2]!;
const PRINCIPAL_ID = ids[3]!;
const ADAPTER_ID = ids[4]!;
const RELEASE_ID = ids[5]!;
const DEFINITION_ID = ids[6]!;
const HOSTED_TOOL = "orders.lookup";
const CREATED_AT = "2026-07-26T12:00:00.000Z";
const EXPIRES_AT = "2026-07-27T12:00:00.000Z";
const MICROVM_SANDBOX = { mode: "run-ephemeral", provider: "aws_lambda_microvm" } as const;

const contentHash = (source: string) =>
  `sha256:${createHash("sha256").update(source).digest("hex")}`;
const V1_HASH = contentHash("export function handler() { return { v: 1 }; }");
const V2_HASH = contentHash("export function handler() { return { v: 2 }; }");

function artifact(hash: string, versionId: string) {
  return Schema.decodeUnknownSync(HostedCodeArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        byteSize: 48,
        contentHash: hash,
        createdAt: CREATED_AT,
        createdByPrincipalId: PRINCIPAL_ID,
        environmentId: ENVIRONMENT_ID,
        language: "javascript",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        sourceByteSize: 60,
        sourceContentHash: contentHash(`typescript ${versionId}`),
        sourceLanguage: "typescript",
        storage: {
          bucket: "platform-artifacts",
          byteSize: 48,
          key: `organizations/${ORGANIZATION_ID}/hosted-code-artifacts/${hash.slice(7)}.mjs`,
          versionId,
        },
        version: 0,
      },
      itemType: "hosted-code-artifact",
    }),
  );
}

function hostedAdapter(version: number, hash: string, timeoutMs: number) {
  return Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: CREATED_AT,
        defaultPolicyAction: "allow",
        description: "Look up an order.",
        effect: "execute",
        environmentId: ENVIRONMENT_ID,
        execution: {
          contentHash: hash,
          entrypoint: "handler",
          language: "javascript",
          memoryMiB: 256,
          network: "none",
          secretNames: ["ORDERS_TOKEN"],
          sourceLanguage: "typescript",
          timeoutMs,
          type: "hosted_code",
        },
        id: ADAPTER_ID,
        inputSchema: { properties: { orderId: { type: "string" } }, type: "object" },
        name: HOSTED_TOOL,
        organizationId: ORGANIZATION_ID,
        outputSchema: { type: "object" },
        projectId: PROJECT_ID,
        requiredScopes: [],
        status: "active",
        updatedAt: CREATED_AT,
        version,
      },
      itemType: "tool-adapter",
    }),
  );
}

function manifest(
  sandbox: { readonly mode: string; readonly provider?: string },
  authorization?: "workspace",
) {
  const validation = validateAgentManifest({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "orders.assistant", name: "Orders Assistant", version: "1.0.0" },
    spec: {
      capabilities: {
        tools: [
          {
            ...(authorization ? { authorization } : {}),
            name: HOSTED_TOOL,
            required: true,
            requiredScopes: [],
          },
        ],
      },
      instructions: "Answer order questions.",
      model: { id: "openrouter/default" },
      sandbox,
    },
  });
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation;
}

function binding(
  id: Ulid,
  options: {
    readonly authorization?: "workspace";
    readonly sandbox?: { readonly mode: string; readonly provider?: string };
    readonly source?: "manifest" | "release";
  } = {},
): ExecutionBindingRecordValue {
  const validated = manifest(options.sandbox ?? MICROVM_SANDBOX, options.authorization);
  return Schema.decodeUnknownSync(ExecutionBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        contentHash: validated.contentHash,
        createdAt: CREATED_AT,
        createdBy: { id: PRINCIPAL_ID, type: "principal" as const },
        environmentId: ENVIRONMENT_ID,
        expiresAt: EXPIRES_AT,
        id,
        idempotencyKey: `binding-${id}`,
        manifest: validated.manifest,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        purpose: "preview" as const,
        source:
          options.source === "release"
            ? {
                agentDefinitionId: DEFINITION_ID,
                agentReleaseId: RELEASE_ID,
                type: "release" as const,
              }
            : { type: "manifest" as const },
        status: "active" as const,
        toolPolicy: "interactive" as const,
        updatedAt: CREATED_AT,
        version: 0,
      },
      itemType: "execution-binding" as const,
      ttl: Math.floor(Date.parse(EXPIRES_AT) / 1_000),
    }),
  );
}

function createInput(record: ExecutionBindingRecordValue) {
  return {
    binding: record,
    event: makeSemanticEventRecord({
      aggregateId: record.data.id,
      aggregateType: "execution-binding",
      aggregateVersion: 1,
      environmentId: ENVIRONMENT_ID,
      eventId: ids[19]!,
      eventType: "execution-binding.created",
      occurredAt: new Date(CREATED_AT),
      organizationId: ORGANIZATION_ID,
      payload: {},
      projectId: PROJECT_ID,
    }),
    idempotency: Schema.decodeUnknownSync(IdempotencyRecord)(
      withCanonicalRecordKeys({
        data: {
          commandHash: `command-${record.data.id}`,
          createdAt: CREATED_AT,
          expiresAt: EXPIRES_AT,
          idempotencyKey: `binding-${record.data.id}`,
          organizationId: ORGANIZATION_ID,
          resourceIds: [record.data.id],
          status: "completed" as const,
          version: 0,
        },
        itemType: "idempotency" as const,
        ttl: Math.floor(Date.parse(EXPIRES_AT) / 1_000),
      }),
    ),
    transactionToken: `create-${record.data.id}`,
  };
}

function fixture() {
  const adapter = hostedAdapter(0, V1_HASH, 5_000);
  const claims = uniqueClaimRequirements(adapter).map((requirement) =>
    Schema.decodeUnknownSync(UniqueClaimRecord)(makeUniqueClaimRecord(requirement, CREATED_AT)),
  );
  const memory = evaluationMemoryDatabase([
    artifact(V1_HASH, "object-version-1"),
    artifact(V2_HASH, "object-version-2"),
    adapter,
    ...claims,
  ]);
  const replace = (record: PlatformRecord) =>
    memory.records.set(`control\u0000${record.pk}\u0000${record.sk}`, record);
  const loadPin = (executionBindingId: Ulid, at = new Date(CREATED_AT)) =>
    loadExecutionBindingHostedCodeTool(
      memory.database,
      { executionBindingId, organizationId: ORGANIZATION_ID, toolName: HOSTED_TOOL },
      at,
    );
  const pins = () =>
    memory.all().filter((record) => record.itemType === "execution-binding-hosted-code-tool");
  return {
    loadPin,
    memory,
    persistence: makeExecutionBindingPersistence(memory.database),
    pins,
    replace,
  };
}

describe("execution binding hosted code pins", () => {
  test("a manifest binding pins the exact artifact atomically with the binding", async () => {
    const { loadPin, memory, persistence } = fixture();
    const created = binding(ids[10]!);

    const snapshot = await persistence.snapshotHostedCodeTools(created);
    expect(snapshot.issues).toEqual([]);
    expect(
      persistence.create({ ...createInput(created), hostedCodeTools: snapshot.pins }),
    ).resolves.toBe(true);

    expect(memory.transactions).toHaveLength(1);
    expect(
      memory.transactions[0]!.map((operation) =>
        operation.kind === "condition-check" ? operation.kind : operation.record.itemType,
      ),
    ).toEqual([
      "execution-binding",
      "execution-binding-hosted-code-tool",
      "idempotency",
      "semantic-event",
    ]);
    const pin = await loadPin(created.data.id);
    expect(pin).toMatchObject({
      data: {
        artifact: { versionId: "object-version-1" },
        contentHash: V1_HASH,
        executionBindingId: created.data.id,
        expiresAt: EXPIRES_AT,
        secretNames: ["ORDERS_TOKEN"],
        timeoutMs: 5_000,
        toolAdapterId: ADAPTER_ID,
        toolAdapterVersion: 0,
        version: 0,
      },
      pk: `ORG#${ORGANIZATION_ID}#EXECUTION-BINDING#${created.data.id}`,
      sk: `EXECUTION-BINDING-HOSTED-CODE-TOOL#${HOSTED_TOOL}`,
      ttl: created.ttl,
    });
  });

  test("later extension changes do not change a created binding's pin", async () => {
    const { loadPin, persistence, replace } = fixture();
    const first = binding(ids[10]!);
    const firstSnapshot = await persistence.snapshotHostedCodeTools(first);
    await persistence.create({ ...createInput(first), hostedCodeTools: firstSnapshot.pins });
    const pinned = await loadPin(first.data.id);

    replace(hostedAdapter(1, V2_HASH, 30_000));
    const second = binding(ids[11]!);
    const secondSnapshot = await persistence.snapshotHostedCodeTools(second);
    await persistence.create({ ...createInput(second), hostedCodeTools: secondSnapshot.pins });

    expect(await loadPin(first.data.id)).toEqual(pinned);
    expect((await loadPin(second.data.id))?.data).toMatchObject({
      artifact: { versionId: "object-version-2" },
      contentHash: V2_HASH,
      timeoutMs: 30_000,
      toolAdapterVersion: 1,
    });
  });

  test("applies the release publish rules to manifest bindings", async () => {
    const { persistence } = fixture();
    const cases = [
      [{ sandbox: { mode: "none" } }, "hosted_code_tool_without_sandbox"],
      [{ authorization: "workspace" }, "hosted_code_tool_workspace_authorization"],
    ] as const;
    for (const [options, code] of cases) {
      const snapshot = await persistence.snapshotHostedCodeTools(binding(ids[10]!, options));
      expect(snapshot.pins).toEqual([]);
      expect(snapshot.issues.map((issue) => issue.code)).toEqual([code]);
    }
  });

  test("release-sourced bindings get no pins and cannot be written with any", async () => {
    const { memory, persistence, pins } = fixture();
    const released = binding(ids[10]!, { source: "release" });
    const manifestSnapshot = await persistence.snapshotHostedCodeTools(binding(ids[11]!));

    expect(persistence.snapshotHostedCodeTools(released)).resolves.toEqual({
      issues: [],
      pins: [],
    });
    expect(
      persistence.create({ ...createInput(released), hostedCodeTools: manifestSnapshot.pins }),
    ).rejects.toThrow("do not belong to the binding");
    expect(
      persistence.create({
        ...createInput(binding(ids[12]!)),
        hostedCodeTools: manifestSnapshot.pins,
      }),
    ).rejects.toThrow("do not belong to the binding");
    expect(memory.transactions).toHaveLength(0);

    expect(persistence.create({ ...createInput(released), hostedCodeTools: [] })).resolves.toBe(
      true,
    );
    expect(pins()).toEqual([]);
  });

  test("an expired binding pin is never loaded", async () => {
    const { loadPin, persistence } = fixture();
    const created = binding(ids[10]!);
    const snapshot = await persistence.snapshotHostedCodeTools(created);
    await persistence.create({ ...createInput(created), hostedCodeTools: snapshot.pins });

    expect(await loadPin(created.data.id, new Date(Date.parse(EXPIRES_AT) - 1))).toBeDefined();
    expect(await loadPin(created.data.id, new Date(EXPIRES_AT))).toBeUndefined();
  });
});
