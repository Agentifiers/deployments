import type { Brain, BrainGrant } from "@deployments-ai/brains";
import {
  brainErasureRecord,
  brainGrantPlatformRecord,
  brainPlatformRecord,
  brainUlid,
  createBrainRecordOperations,
  DEFAULT_TABLE_NAMES,
  makeBrainDynamoRepository,
  makeDynamoDatabase,
  makeDynamoGovernanceStore,
  makeSemanticEventRecord,
  transactWithSemanticEvents,
  withCanonicalRecordKeys,
  type BrainErasureJob,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import {
  fakeDynamoDocumentClient,
  type FakeDynamoDocumentClient,
} from "@deployments-ai/db/dynamo-testing";
import type { GovernanceObjectStore } from "@deployments-ai/governance";
import type { BrainErasureRuntimeDependencies } from "./erasure-runtime.ts";
import { runBrainErasureTick, type BrainErasureTickResult } from "./erasure-tick.ts";

export const organizationId = "01ARZ3NDEKTSV4RRFFQ69G6006";
const ownerId = "01KYK5W3M7Z4KR6VP8BJTA8ACF";
const requestedAt = "2026-10-01T02:08:35.068Z";
export const minutes = (count: number) => count * 60_000;
export const at = (offset: number) => new Date(Date.parse("2026-10-01T02:40:00.000Z") + offset);

export interface ErasingBrainIds {
  readonly brainId: string;
  readonly erasureId: string;
  readonly eventId: string;
  readonly grantId: string;
  readonly slug: string;
}

export interface ErasureWorld {
  readonly database: DynamoDatabaseService;
  readonly dependencies: (
    input: Pick<BrainErasureRuntimeDependencies, "workerId"> &
      Required<Pick<BrainErasureRuntimeDependencies, "now">> &
      Partial<Pick<BrainErasureRuntimeDependencies, "purgeSearch" | "s3">>,
  ) => BrainErasureRuntimeDependencies;
  readonly dynamo: FakeDynamoDocumentClient;
  readonly job: (ids: Pick<ErasingBrainIds, "brainId" | "erasureId">) => BrainErasureJob;
  readonly tick: (
    now: Date,
    s3?: BrainErasureRuntimeDependencies["s3"],
  ) => Promise<BrainErasureTickResult>;
}

const objectStore = {
  delete: async () => undefined,
  deleteAllVersions: async () => undefined,
} as unknown as GovernanceObjectStore;

const emptyBucket = { send: async () => ({ IsTruncated: false, Versions: [] }) };

async function seedErasingBrain(database: DynamoDatabaseService, ids: ErasingBrainIds) {
  const brain: Brain = {
    createdAt: requestedAt,
    createdByPrincipalId: ownerId,
    id: ids.brainId,
    kind: "company",
    maintenancePolicy: {},
    name: ids.slug,
    organizationId,
    ownershipGeneration: 0,
    retrievalPolicy: {},
    schemaVersion: 1,
    sensitivity: "internal",
    slug: ids.slug,
    status: "erasing",
    updatedAt: requestedAt,
    updatedByPrincipalId: ownerId,
    version: 1,
  };
  const ownerGrant: BrainGrant = {
    brainId: ids.brainId,
    brainKind: "company",
    createdAt: requestedAt,
    grantedByPrincipalId: ownerId,
    id: ids.grantId,
    organizationId,
    permission: "owner",
    status: "active",
    target: { principalId: ownerId, type: "principal" },
    updatedAt: requestedAt,
    version: 0,
  };
  await transactWithSemanticEvents(
    database,
    [
      ...createBrainRecordOperations(brainPlatformRecord(brain), requestedAt),
      ...createBrainRecordOperations(brainGrantPlatformRecord(ownerGrant), requestedAt),
      {
        kind: "put",
        record: brainErasureRecord({
          brainId: ids.brainId,
          contentVerificationCount: 0,
          createdAt: requestedAt,
          erasureGeneration: brain.version,
          id: ids.erasureId,
          nextDueAt: requestedAt,
          organizationId,
          phase: "draining",
          priority: 0,
          requestedByPrincipalId: ownerId,
          status: "pending",
          updatedAt: requestedAt,
          version: 0,
        }),
      },
    ],
    [
      makeSemanticEventRecord({
        aggregateId: brainUlid(ids.brainId),
        aggregateType: "brain",
        aggregateVersion: 1,
        eventId: brainUlid(ids.eventId),
        eventType: "brain.erasure-requested",
        occurredAt: requestedAt,
        organizationId: brainUlid(organizationId),
        payload: { brainId: ids.brainId, erasureId: ids.erasureId, status: "erasing" },
      }),
    ],
  );
}

/** An organization with a ready governance inventory and erasing Brains on conditional storage. */
export async function erasureWorld(brains: readonly ErasingBrainIds[]): Promise<ErasureWorld> {
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: requestedAt,
        id: organizationId,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active",
        updatedAt: requestedAt,
        version: 1,
      },
      itemType: "organization",
    }),
  );
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: { completedAt: requestedAt, id: "v1", sourceExportArns: [] },
      itemType: "governance-inventory-state",
    }),
  );
  for (const ids of brains) await seedErasingBrain(database, ids);
  const dependencies: ErasureWorld["dependencies"] = (input) => ({
    bucket: "content",
    database,
    governanceStore: makeDynamoGovernanceStore(dynamo.client, DEFAULT_TABLE_NAMES, {
      requireTenantInventoryReady: true,
    }),
    now: input.now,
    objectStore,
    purgeDerivedMemories: async () => ({ targets: [] }),
    purgeSearch:
      input.purgeSearch ??
      (async ({ brainId, erasureGeneration, operationId }) => ({
        receipt: {
          brainId: brainUlid(brainId),
          erasureGeneration,
          operationId: brainUlid(operationId),
          targets: [],
        },
        status: "complete",
      })),
    repository: makeBrainDynamoRepository(database),
    s3: input.s3 ?? emptyBucket,
    workerId: input.workerId,
  });
  return {
    database,
    dependencies,
    dynamo,
    job: (ids) =>
      dynamo.get("execution", {
        pk: `ORG#${organizationId}#BRAIN#${ids.brainId}`,
        sk: `BRAIN-ERASURE-JOB#${ids.erasureId}`,
      }) as BrainErasureJob,
    tick: (now, s3 = emptyBucket) =>
      runBrainErasureTick(
        dependencies({ now: () => now, s3, workerId: `tick-${now.toISOString()}` }),
      ),
  };
}
