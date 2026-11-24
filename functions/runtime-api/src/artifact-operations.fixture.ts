import {
  ArtifactRecord,
  Ulid,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { RuntimeApiCredentialPrincipal, RuntimeApiDependencies } from "./runtime-support.ts";

export const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
export const THREAD_ONE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
export const THREAD_TWO_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
export const RUN_ONE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
export const RUN_TWO_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
export const ARTIFACT_ONE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
export const ARTIFACT_TWO_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB5";
export const ARTIFACT_THREE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB6";
export const ARTIFACT_PENDING_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
export const NOW = "2026-07-25T12:00:00.000Z";
const ULID_CHARACTERS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const scope = {
  environmentId: Schema.decodeUnknownSync(Ulid)(ENVIRONMENT_ID),
  organizationId: Schema.decodeUnknownSync(Ulid)(ORGANIZATION_ID),
  projectId: Schema.decodeUnknownSync(Ulid)(PROJECT_ID),
};
export const principal = {
  credential: {
    data: {
      id: Schema.decodeUnknownSync(Ulid)(ARTIFACT_PENDING_ID),
      scopes: ["platform:*"],
      status: "active",
    },
  },
  scope,
  serviceAccount: {
    data: {
      ...scope,
      id: Schema.decodeUnknownSync(Ulid)(ORGANIZATION_ID),
      scopes: ["platform:*"],
      status: "active",
    },
  },
} as unknown as RuntimeApiCredentialPrincipal;
export const otherPrincipal = {
  ...principal,
  serviceAccount: { data: { id: Schema.decodeUnknownSync(Ulid)(PROJECT_ID) } },
} as RuntimeApiCredentialPrincipal;

function storageKey(table: string, value: { readonly pk: string; readonly sk: string }) {
  return `${table}\u0000${value.pk}\u0000${value.sk}`;
}

export function generatedUlid(index: number) {
  return `01ARZ3NDEKTSV4RRFFQ69G5F${ULID_CHARACTERS[Math.floor(index / 32)]}${ULID_CHARACTERS[index % 32]}`;
}

export function makeDatabase() {
  const records = new Map<string, PlatformRecord>();
  const transactionBatches: PlatformRecord[][] = [];
  const put = (table: string, record: PlatformRecord) =>
    records.set(storageKey(table, record), structuredClone(record));
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storageKey("execution", record));
    },
    getRecord: async (table, recordKey) => {
      const record = records.get(storageKey(table, recordKey));
      return record ? structuredClone(record) : undefined;
    },
    putRecord: async (record) => {
      put("execution", record);
    },
    queryRecords: async (_table, input) => {
      const names = input.ExpressionAttributeNames as Record<string, string>;
      const values = input.ExpressionAttributeValues as Record<string, string | undefined>;
      const partitionName = names["#pk"]!;
      const sortName = names["#sk"]!;
      const inSortRange = (sortKey: string) =>
        values[":prefix"] === undefined
          ? sortKey >= values[":lower"]! && sortKey <= values[":upper"]!
          : sortKey.startsWith(values[":prefix"]);
      const matching = [...records.values()]
        .filter((record) => {
          const indexed = record as unknown as Record<string, string | undefined>;
          const sortKey = indexed[sortName];
          return (
            indexed[partitionName] === values[":pk"] &&
            sortKey !== undefined &&
            inSortRange(sortKey)
          );
        })
        .toSorted((left, right) => {
          const leftValue = String((left as unknown as Record<string, unknown>)[sortName]);
          const rightValue = String((right as unknown as Record<string, unknown>)[sortName]);
          return leftValue.localeCompare(rightValue);
        });
      if (input.ScanIndexForward === false) matching.reverse();
      const exclusiveStartKey = input.ExclusiveStartKey as
        | { readonly pk: string; readonly sk: string }
        | undefined;
      const start = exclusiveStartKey
        ? matching.findIndex(
            (record) => record.pk === exclusiveStartKey.pk && record.sk === exclusiveStartKey.sk,
          ) + 1
        : 0;
      const limit = input.Limit ?? 100;
      const items = matching.slice(start, start + limit).map((record) => structuredClone(record));
      const last = items.at(-1);
      return {
        items,
        ...(last && start + items.length < matching.length
          ? {
              lastEvaluatedKey: {
                [partitionName]: (last as unknown as Record<string, unknown>)[partitionName],
                [sortName]: (last as unknown as Record<string, unknown>)[sortName],
                pk: last.pk,
                sk: last.sk,
              },
            }
          : {}),
      };
    },
    transactWrite: async (operations) => {
      transactionBatches.push(
        operations.flatMap((operation) =>
          operation.kind === "condition-check" ? [] : [structuredClone(operation.record)],
        ),
      );
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") {
          records.delete(storageKey("execution", operation.record));
        } else {
          put("execution", operation.record);
        }
      }
    },
  };
  return { database, put, transactionBatches };
}

export function artifact(
  artifactId: string,
  options: {
    readonly accessUrlExpiresAt?: string;
    readonly agentDeploymentId?: string;
    readonly ownerServiceAccountId?: string | null;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly privateAccess?: "brain-authorized" | "runtime-only";
    readonly retentionExpiresAt?: string;
    readonly runId?: string;
    readonly status?: "available" | "pending";
    readonly threadId?: string;
    readonly uploadExpiresAt?: string;
    readonly uploadUrlExpiresAt?: string;
    readonly version?: number;
    readonly visibility?: "organization" | "private";
  } = {},
) {
  return Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(options.accessUrlExpiresAt ? { accessUrlExpiresAt: options.accessUrlExpiresAt } : {}),
        ...(options.agentDeploymentId
          ? { agentDeploymentId: Schema.decodeUnknownSync(Ulid)(options.agentDeploymentId) }
          : {}),
        createdAt: NOW,
        ...scope,
        id: Schema.decodeUnknownSync(Ulid)(artifactId),
        name: `Artifact ${artifactId.at(-1)}`,
        ...(options.metadata ? { metadata: options.metadata } : {}),
        ...(options.ownerServiceAccountId === null
          ? {}
          : {
              owner: {
                serviceAccountId: Schema.decodeUnknownSync(Ulid)(
                  options.ownerServiceAccountId ?? principal.serviceAccount.data.id,
                ),
                type: "service-account",
              },
            }),
        ...(options.privateAccess ? { privateAccess: options.privateAccess } : {}),
        ...(options.retentionExpiresAt ? { retentionExpiresAt: options.retentionExpiresAt } : {}),
        ...(options.runId ? { runId: Schema.decodeUnknownSync(Ulid)(options.runId) } : {}),
        status: options.status ?? "available",
        storage: {
          bucket: "artifact-bucket",
          byteSize: 12,
          contentType: "text/plain",
          fileName: "report.txt",
          key: `artifacts/${artifactId}`,
          sha256: "a".repeat(64),
        },
        ...(options.threadId ? { threadId: Schema.decodeUnknownSync(Ulid)(options.threadId) } : {}),
        type: "report",
        updatedAt: NOW,
        ...(options.uploadExpiresAt ? { uploadExpiresAt: options.uploadExpiresAt } : {}),
        ...(options.uploadUrlExpiresAt ? { uploadUrlExpiresAt: options.uploadUrlExpiresAt } : {}),
        version: options.version ?? 0,
        visibility: options.visibility ?? "private",
      },
      itemType: "artifact",
      ...(options.retentionExpiresAt || options.uploadExpiresAt
        ? {
            ttl: Math.floor(
              Math.max(
                ...[options.retentionExpiresAt, options.uploadExpiresAt]
                  .filter((value): value is string => value !== undefined)
                  .map((value) => Date.parse(value)),
              ) / 1_000,
            ),
          }
        : {}),
    }),
  );
}

export function seedThread(put: (table: string, record: PlatformRecord) => void, threadId: string) {
  const threadKey = {
    pk: key("ORG", ORGANIZATION_ID, "THREAD", threadId),
    sk: key("THREAD", threadId),
  };
  put("execution", {
    ...threadKey,
    data: { ...scope, id: threadId },
    itemType: "thread",
  } as unknown as PlatformRecord);
}

export function seedRun(
  put: (table: string, record: PlatformRecord) => void,
  runId: string,
  threadId: string,
) {
  const runKey = {
    pk: key("ORG", ORGANIZATION_ID, "THREAD", threadId),
    sk: key("RUN", `run-${runId}`),
  };
  put("control", {
    pk: key("ORG", ORGANIZATION_ID, "ENV", ENVIRONMENT_ID),
    sk: key("RUN-LOCATOR", runId),
    data: {
      ...scope,
      runId,
      runPk: runKey.pk,
      runSk: runKey.sk,
    },
    itemType: "run-locator",
  } as unknown as PlatformRecord);
  put("execution", {
    ...runKey,
    data: {
      ...scope,
      captureMode: "metadata-only",
      id: runId,
      spanId: "0123456789abcdef",
      threadId,
      traceId: "0123456789abcdef0123456789abcdef",
    },
    itemType: "run",
  } as unknown as PlatformRecord);
}

export function dependencies(
  database: DynamoDatabaseService,
  send: (command: unknown) => Promise<unknown> = async () => ({}),
) {
  return {
    artifactBucket: "artifact-bucket",
    artifactKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/artifacts",
    artifactS3: { send },
    database,
    generateId: async () => Schema.decodeUnknownSync(Ulid)(ARTIFACT_PENDING_ID),
    now: () => new Date(NOW),
  } as unknown as RuntimeApiDependencies;
}
