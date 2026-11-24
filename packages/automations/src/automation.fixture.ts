import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  ThreadRecord,
  WorkspaceRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TableName,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import {
  agentManifestContentHash,
  AgentManifestV1,
  type AgentTrigger,
} from "@deployments-ai/agent-manifest";
import { Schema } from "effect";

export const ids = Array.from(
  { length: 30 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
) as Ulid[];
export const scope = {
  environmentId: ids[0]!,
  organizationId: ids[1]!,
  projectId: ids[2]!,
  workspaceId: ids[3]!,
};
export const { workspaceId: _workspaceId, ...tenantScope } = scope;
export const agentDeploymentId = ids[4]!;
export const now = new Date("2026-07-23T12:00:00.000Z");

export function agentReleaseRecord(triggers?: readonly AgentTrigger[]) {
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: {
      key: "automation.test-agent",
      name: "Automation Test Agent",
      version: "1.0.0",
    },
    spec: {
      instructions: "Execute the configured automation.",
      model: { id: "openrouter/test" },
      sandbox: { mode: "none" },
      ...(triggers ? { triggers } : {}),
    },
  });
  return Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: ids[28]!,
        contentHash: agentManifestContentHash(manifest),
        createdAt: now.toISOString(),
        createdByPrincipalId: ids[27]!,
        environmentId: scope.environmentId,
        id: ids[29]!,
        manifest,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        releaseNumber: 1,
        status: "active" as const,
        version: 0,
      },
      itemType: "agent-release" as const,
    }),
  );
}

export function workspaceRecord(id = scope.workspaceId, status: "active" | "archived" = "active") {
  return Schema.decodeUnknownSync(WorkspaceRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        environmentId: scope.environmentId,
        id,
        name: `Workspace ${id}`,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        slug: `workspace-${id.toLowerCase()}`,
        status,
        updatedAt: now.toISOString(),
        version: status === "active" ? 0 : 1,
      },
      itemType: "workspace" as const,
    }),
  );
}

export function threadRecord(
  id: Ulid,
  options: {
    readonly agentDeploymentId?: Ulid;
    readonly archived?: boolean;
    readonly workspaceId?: Ulid;
  } = {},
) {
  const archived = options.archived ?? false;
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: options.agentDeploymentId ?? agentDeploymentId,
        archived,
        channel: "api",
        createdAt: now.toISOString(),
        createdBy: { type: "system" as const },
        environmentId: scope.environmentId,
        id,
        organizationId: scope.organizationId,
        pinned: false,
        projectId: scope.projectId,
        streamId: ids[24]!,
        title: `Automation thread ${id}`,
        updatedAt: now.toISOString(),
        version: archived ? 1 : 0,
        workspaceId: options.workspaceId ?? scope.workspaceId,
      },
      itemType: "thread" as const,
    }),
  );
}

export function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const transactions: TransactionOperation[][] = [];
  const itemKey = (table: TableName, pk: string, sk: string) => `${table}\u0000${pk}\u0000${sk}`;
  const put = (record: PlatformRecord) => {
    records.set(itemKey(tableForItemType(record.itemType), record.pk, record.sk), record);
  };
  const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: ids[28]!,
        agentReleaseId: ids[29]!,
        createdAt: now.toISOString(),
        currentState: "ready" as const,
        desiredState: "running" as const,
        environmentId: scope.environmentId,
        id: agentDeploymentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
  put(deployment);
  put(agentReleaseRecord());
  put(workspaceRecord());
  const database = {
    deleteRecord: async () => {},
    getRecord: async (table: TableName, key: { readonly pk: string; readonly sk: string }) =>
      records.get(itemKey(table, key.pk, key.sk)),
    putRecord: async () => {},
    queryRecords: async () => ({ items: [...records.values()] }),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      transactions.push([...operations]);
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const record = operation.record;
        const key = itemKey(tableForItemType(record.itemType), record.pk, record.sk);
        if (operation.kind === "put") records.set(key, record);
        if (operation.kind === "delete") records.delete(key);
      }
    },
  } as unknown as DynamoDatabaseService;
  return { database, put, records, transactions };
}

export function dependencies(memory: ReturnType<typeof memoryDatabase>) {
  let idIndex = 5;
  const runs: unknown[] = [];
  const providerDeletes: Ulid[] = [];
  const providerSchedules: unknown[] = [];
  return {
    dependencies: {
      database: memory.database,
      generateId: async () => ids[idIndex++]!,
      now: () => now,
      submitRun: async (input: unknown) => {
        runs.push(input);
        return { runId: ids[20]!, threadId: ids[21]! };
      },
      timerProvider: {
        delete: async (scheduleId: Ulid) => {
          providerDeletes.push(scheduleId);
        },
        upsert: async (input: unknown) => {
          providerSchedules.push(input);
        },
      },
    },
    providerSchedules,
    providerDeletes,
    runs,
  };
}
