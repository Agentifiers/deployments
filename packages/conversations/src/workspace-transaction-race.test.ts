import { describe, expect, test } from "bun:test";
import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  WorkspaceRecord,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TableName,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createConversationService } from "./index.ts";

const ids = Array.from(
  { length: 16 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G6F${String(index).padStart(2, "0")}`,
) as Ulid[];
const [
  organizationId,
  projectId,
  environmentId,
  workspaceId,
  definitionId,
  releaseId,
  deploymentId,
] = ids as [Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid];
const now = new Date("2026-07-24T12:00:00.000Z");

function recordMapKey(table: TableName, pk: string, sk: string) {
  return `${table}\u0000${pk}\u0000${sk}`;
}

describe("conversation workspace transaction validation", () => {
  test("reports a concurrent workspace archive as unavailable", async () => {
    const environmentPk = key("ORG", organizationId, "ENV", environmentId);
    const activeWorkspace = Schema.decodeUnknownSync(WorkspaceRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: now.toISOString(),
          environmentId,
          id: workspaceId,
          name: "Runtime workspace",
          organizationId,
          projectId,
          slug: "runtime-workspace",
          status: "active" as const,
          updatedAt: now.toISOString(),
          version: 0,
        },
        itemType: "workspace" as const,
      }),
    );
    const archivedWorkspace = Schema.decodeUnknownSync(WorkspaceRecord)({
      ...activeWorkspace,
      data: { ...activeWorkspace.data, status: "archived", version: 1 },
    });
    const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
      apiVersion: "agents.deployments.ai/v1",
      kind: "Agent",
      metadata: {
        key: "workspace-race.test-agent",
        name: "Workspace Race Test Agent",
        version: "1.0.0",
      },
      spec: {
        instructions: "Respond to the conversation.",
        model: { id: "openrouter/test" },
        sandbox: { mode: "none" },
      },
    });
    const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDefinitionId: definitionId,
          contentHash: agentManifestContentHash(manifest),
          createdAt: now.toISOString(),
          createdByPrincipalId: ids[7]!,
          environmentId,
          id: releaseId,
          manifest,
          organizationId,
          projectId,
          releaseNumber: 1,
          status: "active" as const,
          version: 0,
        },
        itemType: "agent-release" as const,
      }),
    );
    const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDefinitionId: definitionId,
          agentReleaseId: releaseId,
          createdAt: now.toISOString(),
          currentState: "ready" as const,
          desiredState: "running" as const,
          environmentId,
          id: deploymentId,
          organizationId,
          projectId,
          updatedAt: now.toISOString(),
          version: 0,
        },
        itemType: "agent-deployment" as const,
      }),
    );
    const records = new Map<string, PlatformRecord>([
      [recordMapKey("control", deployment.pk, deployment.sk), deployment],
      [recordMapKey("control", release.pk, release.sk), release],
    ]);
    let workspaceReads = 0;
    const database = {
      getRecord: async (
        table: TableName,
        recordKey: { readonly pk: string; readonly sk: string },
      ) =>
        recordKey.pk === environmentPk && recordKey.sk === key("WORKSPACE", workspaceId)
          ? workspaceReads++ === 0
            ? activeWorkspace
            : archivedWorkspace
          : records.get(recordMapKey(table, recordKey.pk, recordKey.sk)),
      // No budgets govern this scope.
      queryRecords: async () => ({ items: [] }),
      transactWrite: () => Promise.reject(new Error("workspace condition failed")),
    } as unknown as DynamoDatabaseService;
    let enqueues = 0;
    let generatedIds = 8;
    const service = createConversationService({
      database,
      enqueueRun: async () => void (enqueues += 1),
      generateId: async () => ids[generatedIds++]!,
      now: () => now,
    });

    expect(
      service.submitTurn({
        actor: { type: "system" },
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        content: "Do not run in an archived workspace",
        environmentId,
        idempotencyKey: "workspace-archive-race",
        organizationId,
        projectId,
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
    expect(enqueues).toBe(0);
  });
});
