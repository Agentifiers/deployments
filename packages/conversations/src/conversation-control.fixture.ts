import {
  agentManifestContentHash,
  AgentManifestV1,
  DOCUMENT_MEDIA_TYPES,
  INPUT_AUDIO_MEDIA_TYPES,
  INPUT_IMAGE_MEDIA_TYPES,
} from "@deployments-ai/agent-manifest";
import {
  AgentDeploymentRecord,
  ArtifactRecord,
  AgentReleaseRecord,
  BudgetRecord,
  ScopeSpendShardRecord,
  budgetPeriodBounds,
  scopeChain,
  tableForItemType,
  withCanonicalRecordKeys,
  WorkspaceRecord,
  type ArtifactInputFile,
  type ArtifactOwner,
  type DynamoDatabaseService,
  type PlatformRecord,
  type ScopeLevel,
  type TableName,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";

export const ids = Array.from(
  { length: 40 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
) as Ulid[];
export const organizationId = ids[0]!;
export const projectId = ids[1]!;
export const environmentId = ids[2]!;
export const workspaceId = ids[3]!;
const definitionId = ids[4]!;
export const releaseId = ids[5]!;
export const deploymentId = ids[6]!;
export const now = new Date("2026-07-23T12:00:00.000Z");

export function controlFixtures(
  options: {
    readonly model?: { readonly fallbackIds?: readonly string[]; readonly id: string };
    readonly runtime?: { readonly ingressAttachments?: "attach" };
  } = {},
) {
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: {
      key: "conversation.test-agent",
      name: "Conversation Test Agent",
      version: "1.0.0",
    },
    spec: {
      instructions: "Respond to the conversation.",
      model: options.model ?? { id: "openrouter/qwen/qwen3.7-plus" },
      ...(options.runtime ? { runtime: options.runtime } : {}),
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
  return { deployment, release };
}

function resolution(contentType: string): ArtifactInputFile {
  const image = INPUT_IMAGE_MEDIA_TYPES.find((type) => type === contentType);
  if (image) return { kind: "image", mediaType: image };
  const audio = INPUT_AUDIO_MEDIA_TYPES.find((type) => type === contentType);
  if (audio) return { kind: "audio", mediaType: audio };
  const document = DOCUMENT_MEDIA_TYPES.find((type) => type === contentType);
  if (!document) return { kind: "unusable", reason: "unsupported_type" };
  return {
    kind: "document",
    mediaType: document,
    summary: "test document",
    text: {
      byteSize: 1_024,
      extractor: "document-text-v1",
      sha256: "c".repeat(64),
      truncated: false,
      versionId: "text-v1",
    },
  };
}

export function inputArtifact(options: {
  readonly byteSize?: number;
  readonly contentType: string;
  readonly id: Ulid;
  readonly input?: ArtifactInputFile;
  readonly name?: string;
  readonly owner: ArtifactOwner;
  readonly threadId: Ulid;
}) {
  return Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        environmentId,
        id: options.id,
        input: options.input ?? resolution(options.contentType),
        name: options.name ?? options.id,
        organizationId,
        owner: options.owner,
        projectId,
        status: "available" as const,
        storage: {
          bucket: "private",
          byteSize: options.byteSize ?? 100,
          contentType: options.contentType,
          key: options.id,
          sha256: "a".repeat(64),
          versionId: "v1",
        },
        threadId: options.threadId,
        type: "input",
        updatedAt: now.toISOString(),
        version: 0,
        visibility: "private" as const,
      },
      itemType: "artifact" as const,
    }),
  );
}

export function memoryDatabase(seed: readonly PlatformRecord[] = []) {
  const records = new Map<string, PlatformRecord>();
  const transactions: TransactionOperation[][] = [];
  const recordKey = (table: TableName, pk: string, sk: string) => `${table}\u0000${pk}\u0000${sk}`;
  const workspace = Schema.decodeUnknownSync(WorkspaceRecord)(
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
  records.set(
    recordKey(tableForItemType(workspace.itemType), workspace.pk, workspace.sk),
    workspace,
  );
  for (const item of seed) {
    records.set(recordKey(tableForItemType(item.itemType), item.pk, item.sk), item);
  }
  const database = {
    deleteRecord: async () => {},
    getRecord: async (table: TableName, key: { readonly pk: string; readonly sk: string }) =>
      records.get(recordKey(table, key.pk, key.sk)),
    putRecord: async (item: PlatformRecord) => {
      records.set(recordKey(tableForItemType(item.itemType), item.pk, item.sk), item);
    },
    queryRecords: async (table: TableName, input: Record<string, unknown>) => {
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      const tableItems = [...records.values()].filter(
        (item) => tableForItemType(item.itemType) === table,
      );
      if (values[":partition"] !== undefined) {
        const names = input.ExpressionAttributeNames as Record<string, string>;
        const attribute = (item: PlatformRecord, name: string) =>
          (item as unknown as Record<string, unknown>)[names[name]!];
        const items = tableItems
          .filter((item) => {
            const sort = attribute(item, "#sort");
            return (
              attribute(item, "#partition") === values[":partition"] &&
              (typeof sort === "string" ? sort : "").startsWith(String(values[":prefix"]))
            );
          })
          .toSorted((left, right) =>
            String(attribute(left, "#sort")).localeCompare(String(attribute(right, "#sort"))),
          );
        return { items };
      }
      const items = tableItems
        .filter((item) => item.pk === values[":pk"])
        .filter((item) => item.sk.startsWith("MESSAGE#"))
        .toSorted((left, right) => left.sk.localeCompare(right.sk));
      return { items };
    },
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      transactions.push([...operations]);
      for (const operation of operations) {
        if (operation.kind === "put") {
          const item = operation.record;
          records.set(recordKey(tableForItemType(item.itemType), item.pk, item.sk), item);
        } else if (operation.kind === "delete") {
          const item = operation.record;
          records.delete(recordKey(tableForItemType(item.itemType), item.pk, item.sk));
        }
      }
    },
  } as unknown as DynamoDatabaseService;
  const put = (item: PlatformRecord) =>
    records.set(recordKey(tableForItemType(item.itemType), item.pk, item.sk), item);
  return { database, put, records, transactions };
}

export function idGenerator(start = 8) {
  let index = start;
  return async () => ids[index++]!;
}

/**
 * An exhausted budget on one level of the fixture scope, whose workspace is `workspaceId`: the
 * budget plus current-period spend shards summing to its amount at that level only.
 */
export function exhaustedBudget(
  scope: ScopeLevel,
  options: { readonly name?: string; readonly status?: "active" | "archived" | "paused" } = {},
) {
  const status = options.status ?? "active";
  const { scope: _scope, ...scopeFields } =
    scopeChain({ environmentId, organizationId, projectId, workspaceId }).find(
      (target) => target.scope === scope,
    ) ?? {};
  const amountUsdMicros = 5_000_000;
  const budget = Schema.decodeUnknownSync(BudgetRecord)(
    withCanonicalRecordKeys({
      data: {
        amountUsdMicros,
        ...(status === "archived" ? { archivedAt: now.toISOString() } : {}),
        createdAt: now.toISOString(),
        id: ids[39]!,
        name: options.name ?? `${scope} monthly`,
        organizationId,
        period: "monthly" as const,
        scope,
        status,
        thresholds: [50, 80, 100],
        updatedAt: now.toISOString(),
        version: 1,
        ...scopeFields,
      },
      itemType: "budget" as const,
    }),
  );
  const { periodStart } = budgetPeriodBounds("monthly", now);
  const shards = [3_000_000, 2_000_000].map((spendUsdMicros, shard) =>
    Schema.decodeUnknownSync(ScopeSpendShardRecord)(
      withCanonicalRecordKeys({
        data: {
          organizationId,
          period: "monthly" as const,
          periodStart,
          scope,
          shard,
          spendUsdMicros,
          updatedAt: now.toISOString(),
          version: 1,
          ...scopeFields,
        },
        itemType: "scope-spend-shard" as const,
      }),
    ),
  );
  return { budget, periodStart, records: [budget, ...shards] as PlatformRecord[] };
}
