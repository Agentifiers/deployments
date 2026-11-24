import {
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { withMemorySearchTargetDirectory } from "@deployments-ai/db/dynamo-testing";
import { makeMemorySearchRegistration } from "./control-plane-registration.ts";
import type { MemorySearchErasureResult } from "@deployments-ai/governance";
import type { MemorySearchTarget } from "./provider.ts";
import { ids, memoryEmbeddingGatewayRoute } from "./test-fixtures.ts";

export interface ErasureDatabaseFixture {
  readonly apply: (operations: readonly TransactionOperation[]) => void;
  readonly database: DynamoDatabaseService;
  readonly records: () => PlatformRecord[];
  readonly transactions: TransactionOperation[][];
}

export function databaseFixture(): ErasureDatabaseFixture {
  const values = new Map<string, PlatformRecord>();
  const transactions: TransactionOperation[][] = [];
  const apply = (operations: readonly TransactionOperation[]) => {
    for (const operation of withMemorySearchTargetDirectory(operations)) {
      if (operation.kind === "put") {
        values.set(`${operation.record.pk}\0${operation.record.sk}`, operation.record);
      } else if (operation.kind === "delete") {
        values.delete(`${operation.record.pk}\0${operation.record.sk}`);
      }
    }
  };
  return {
    apply,
    database: {
      getRecord: async (_table: string, key: { readonly pk: string; readonly sk: string }) => {
        const value = values.get(`${key.pk}\0${key.sk}`);
        return value;
      },
      queryRecords: async (
        _table: string,
        input: {
          readonly ExpressionAttributeValues?: Readonly<Record<string, unknown>>;
          readonly Limit?: number;
        },
      ) => {
        const pk = input.ExpressionAttributeValues?.[":pk"];
        const prefix = input.ExpressionAttributeValues?.[":prefix"];
        const matches = [...values.values()]
          .filter(
            (record) =>
              record.pk === pk &&
              (prefix === undefined ||
                (typeof prefix === "string" && record.sk.startsWith(prefix))),
          )
          .toSorted((left, right) => (left.sk < right.sk ? -1 : left.sk > right.sk ? 1 : 0));
        const items = matches.slice(0, input.Limit);
        const last = items.at(-1);
        return matches.length > items.length && last
          ? { items, lastEvaluatedKey: { pk: last.pk, sk: last.sk } }
          : { items };
      },
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        apply(operations);
      },
      transactWriteForErasure: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        apply(operations);
      },
    } as unknown as DynamoDatabaseService,
    records: () => [...values.values()],
    transactions,
  };
}

export function completedErasure(result: MemorySearchErasureResult) {
  if (result.status === "pending") {
    throw new Error(`Memory erasure is still pending: ${result.reason}.`);
  }
  return result.receipt;
}

export const erasureLocation = {
  automatedSnapshotRetentionHours: 336,
  backupSafetyMarginMinutes: 60,
  embeddingDimensions: 3,
  openSearchEndpoint: "https://search.example",
  openSearchIndex: "memory-v3",
  region: "us-east-2",
};

export const otherErasureLocation = { ...erasureLocation, openSearchIndex: "memory-v3-other" };

export const primaryErasureTarget: MemorySearchTarget = {
  componentIds: [ids.space],
  embeddingProfileId: ids.agent,
  location: erasureLocation,
  providerId: "aws-native",
  schemaGeneration: 1,
  targetId: ids.run,
};

export const secondaryErasureTarget: MemorySearchTarget = {
  componentIds: [ids.memory],
  embeddingProfileId: ids.agent,
  location: otherErasureLocation,
  providerId: "aws-native",
  schemaGeneration: 1,
  targetId: ids.thread,
};

export async function seedErasurePlacement(args: {
  readonly fixture: ErasureDatabaseFixture;
  readonly membershipDigest: (
    targetId: Ulid,
  ) => Promise<{ readonly digest: string; readonly keyVersion: number }>;
  readonly targets: readonly [MemorySearchTarget, ...MemorySearchTarget[]];
  readonly timestamp: string;
}) {
  const { fixture, targets, timestamp } = args;
  const registration = makeMemorySearchRegistration({
    database: fixture.database,
    membershipDigest: args.membershipDigest,
    now: () => new Date(timestamp),
  });
  await registration.registerCatalog({
    components: [
      {
        componentKind: "dense",
        embeddingProfileId: ids.agent,
        generationId: ids.memory2,
        id: ids.space,
        location: erasureLocation,
        providerId: "aws-native",
        schemaGeneration: 1,
      },
      {
        componentKind: "dense",
        embeddingProfileId: ids.agent,
        generationId: ids.workspace,
        id: ids.memory,
        location: otherErasureLocation,
        providerId: "aws-native",
        schemaGeneration: 1,
      },
    ],
    generations: [
      {
        componentKind: "dense",
        generation: 1,
        id: ids.memory2,
        location: erasureLocation,
        providerId: "aws-native",
      },
      {
        componentKind: "dense",
        generation: 1,
        id: ids.workspace,
        location: otherErasureLocation,
        providerId: "aws-native",
      },
    ],
    profile: {
      dimensions: 3,
      distanceMetric: "cosine",
      gatewayModel: "openai/text-embedding-3-small",
      gatewayRoute: memoryEmbeddingGatewayRoute,
      id: ids.agent,
      normalization: "l2",
      processingBoundary: "aws",
    },
  });
  for (const target of targets) {
    fixture.apply(
      await registration.registrationOperations({
        operationId: ids.toolCall,
        organizationId: ids.organization,
        placementGeneration: 1,
        target,
        timestamp,
      }),
    );
  }
  const gates = fixture
    .records()
    .filter((record) => record.itemType === "memory-provider-mutation-gate");
  fixture.apply(
    gates.map((gate) => ({
      kind: "put" as const,
      previousRecord: gate,
      record: {
        ...gate,
        data: {
          ...gate.data,
          operationId: ids.toolCall,
          status: "closed",
          updatedAt: timestamp,
          version: gate.data.version + 1,
        },
      } as PlatformRecord,
    })),
  );
  fixture.apply([
    {
      kind: "put",
      record: withCanonicalRecordKeys({
        data: {
          createdAt: timestamp,
          generation: 1,
          organizationId: ids.organization,
          phase: "active" as const,
          readTarget: targets[0],
          updatedAt: timestamp,
          version: 0,
          writeTargets: [...targets],
        },
        itemType: "memory-search-placement" as const,
      }) as PlatformRecord,
    },
  ]);
}
