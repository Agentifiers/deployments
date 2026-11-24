import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import {
  AgentReleaseRecord,
  HostedCodeArtifactRecord,
  makeManifestModelAdmission,
  makeUniqueClaimRecord,
  ToolAdapterRecord,
  uniqueClaimRequirements,
  UniqueClaimRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  environmentId,
  idGenerator,
  ids,
  memoryDatabase,
  now,
  organizationId,
  projectId,
} from "./conversation-control.fixture.ts";
import {
  DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
  createExecutionBindingService,
  type CreateExecutionBindingInput,
} from "./index.ts";

const HOSTED_TOOL = "orders.lookup";
const ADAPTER_ID = ids[35]!;
const RELEASE_ID = ids[36]!;
const CODE_HASH = `sha256:${createHash("sha256").update("export function handler() {}").digest("hex")}`;
const MICROVM_SANDBOX = { mode: "run-ephemeral", provider: "aws_lambda_microvm" };

function manifest(sandbox: Readonly<Record<string, string>>, authorization?: "workspace") {
  return {
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
      model: { id: "openrouter/qwen/qwen3.7-plus" },
      sandbox,
    },
  };
}

function hostedCodeSeed(): PlatformRecord[] {
  const scope = { environmentId, organizationId, projectId };
  const adapter = Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        createdAt: now.toISOString(),
        defaultPolicyAction: "allow",
        description: "Look up an order.",
        effect: "execute",
        execution: {
          contentHash: CODE_HASH,
          entrypoint: "handler",
          language: "javascript",
          memoryMiB: 256,
          network: "none",
          secretNames: [],
          sourceLanguage: "javascript",
          timeoutMs: 5_000,
          type: "hosted_code",
        },
        id: ADAPTER_ID,
        inputSchema: { type: "object" },
        name: HOSTED_TOOL,
        outputSchema: { type: "object" },
        requiredScopes: [],
        status: "active",
        updatedAt: now.toISOString(),
        version: 3,
      },
      itemType: "tool-adapter",
    }),
  );
  const artifact = Schema.decodeUnknownSync(HostedCodeArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        byteSize: 28,
        contentHash: CODE_HASH,
        createdAt: now.toISOString(),
        createdByPrincipalId: ids[30]!,
        language: "javascript",
        sourceByteSize: 28,
        sourceContentHash: CODE_HASH,
        sourceLanguage: "javascript",
        storage: {
          bucket: "platform-artifacts",
          byteSize: 28,
          key: `organizations/${organizationId}/hosted-code-artifacts/${CODE_HASH.slice(7)}.mjs`,
          versionId: "object-version-7",
        },
        version: 0,
      },
      itemType: "hosted-code-artifact",
    }),
  );
  const decoded = Schema.decodeUnknownSync(AgentManifestV1)(manifest(MICROVM_SANDBOX));
  const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        agentDefinitionId: ids[4]!,
        contentHash: agentManifestContentHash(decoded),
        createdAt: now.toISOString(),
        createdByPrincipalId: ids[30]!,
        id: RELEASE_ID,
        manifest: decoded,
        releaseNumber: 2,
        status: "active" as const,
        version: 0,
      },
      itemType: "agent-release" as const,
    }),
  );
  return [
    adapter,
    artifact,
    release,
    ...uniqueClaimRequirements(adapter).map((requirement) =>
      Schema.decodeUnknownSync(UniqueClaimRecord)(
        makeUniqueClaimRecord(requirement, now.toISOString()),
      ),
    ),
  ];
}

function setup() {
  const memory = memoryDatabase(hostedCodeSeed());
  const bindings = createExecutionBindingService({
    admitManifest: makeManifestModelAdmission(memory.database),
    database: memory.database,
    generateId: idGenerator(),
    now: () => now,
  });
  const recordsOf = (itemType: string) =>
    [...memory.records.values()].filter((record) => record.itemType === itemType);
  return { bindings, memory, recordsOf };
}

function input(
  source: CreateExecutionBindingInput["source"],
  idempotencyKey = "hosted-binding",
): CreateExecutionBindingInput {
  return {
    createdBy: { id: ids[30]!, type: "principal" },
    environmentId,
    idempotencyKey,
    organizationId,
    projectId,
    purpose: "preview",
    source,
    toolPolicy: "interactive",
    ttlSeconds: DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
  };
}

describe("execution binding hosted code tools", () => {
  test("a manifest binding writes its pins in the binding's creation transaction", async () => {
    const { bindings, memory, recordsOf } = setup();

    const { binding } = await bindings.createExecutionBinding(
      input({ manifest: manifest(MICROVM_SANDBOX), type: "manifest" }),
    );

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
    expect(recordsOf("execution-binding-hosted-code-tool")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          artifact: expect.objectContaining({ versionId: "object-version-7" }),
          contentHash: CODE_HASH,
          executionBindingId: binding.data.id,
          expiresAt: binding.data.expiresAt,
          toolAdapterId: ADAPTER_ID,
          toolAdapterVersion: 3,
        }),
        ttl: binding.ttl,
      }),
    ]);
  });

  test("rejects manifests that break the hosted code rules and writes nothing", async () => {
    const { bindings, memory } = setup();
    const workspaceConfig = {
      apiVersion: "agents.deployments.ai/v1" as const,
      kind: "AgentDeploymentConfig" as const,
      toolAuthorizations: { [HOSTED_TOOL]: { authorizationId: ids[37]! } },
    };
    const rejected = [
      { candidate: manifest({ mode: "none" }) },
      { candidate: manifest(MICROVM_SANDBOX, "workspace"), runtimeConfig: workspaceConfig },
    ];
    for (const [index, { candidate, runtimeConfig }] of rejected.entries()) {
      expect(
        bindings.createExecutionBinding({
          ...input({ manifest: candidate, type: "manifest" }, `rejected-${index}`),
          ...(runtimeConfig ? { runtimeConfig } : {}),
        }),
      ).rejects.toMatchObject({
        code: "invalid_agent_manifest",
        message: expect.stringContaining(`Hosted code tool ${HOSTED_TOOL}`),
      });
    }
    expect(memory.transactions).toHaveLength(0);
  });

  test("a release-sourced binding writes no pins of its own", async () => {
    const { bindings, memory, recordsOf } = setup();

    const { binding } = await bindings.createExecutionBinding(
      input({ agentReleaseId: RELEASE_ID, type: "release" }),
    );

    expect(binding.data.source).toMatchObject({ agentReleaseId: RELEASE_ID, type: "release" });
    expect(memory.transactions).toHaveLength(1);
    expect(recordsOf("execution-binding-hosted-code-tool")).toEqual([]);
  });
});
