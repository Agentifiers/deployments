import {
  DatabaseError,
  decodePlatformRecord,
  makeIdentityRepository,
  principalRecord,
  securityStateRecord,
  sessionRecords,
  tableForItemType,
  type DynamoDatabaseService,
  type IdentityRepository,
  type PlatformRecord,
  type TableName,
  type Ulid,
} from "@deployments-ai/db";
import { sha256 } from "@deployments-ai/identity";
import { Effect } from "effect";
import { makeIdentityApplication } from "./application.ts";

const versionOf = (record: PlatformRecord | undefined) =>
  record && "version" in record.data ? record.data.version : undefined;

export const CREATED_AT = "2026-07-28T00:00:00.000Z";
export const NOW = "2026-07-28T01:00:00.000Z";

/**
 * In-memory identity table behind the real identity repository. Puts are canonicalized like the
 * DynamoDB adapter, versioned puts enforce `previousRecord`, and only the GSI1 session-listing
 * key conditions are understood — any other query shape fails the test.
 */
export function memoryIdentityStore(seed: readonly PlatformRecord[]) {
  const records = new Map<string, PlatformRecord>();
  const storageKey = (table: TableName, pk: string, sk: string) => `${table}\u0000${pk}\u0000${sk}`;
  const store = (record: PlatformRecord) =>
    records.set(storageKey(tableForItemType(record.itemType), record.pk, record.sk), record);
  seed.forEach(store);
  const queries: Record<string, unknown>[] = [];
  const conflict = (message: string) =>
    new DatabaseError({
      cause: new Error("ConditionalCheckFailedException"),
      message,
      operation: "transact-write",
      reason: "conflict",
      table: "multiple",
    });

  const database: DynamoDatabaseService = {
    deleteRecord: () => Promise.reject(new Error("Unexpected delete.")),
    getRecord: async (table, key) => records.get(storageKey(table, key.pk, key.sk)),
    putRecord: () => Promise.reject(new Error("Unexpected non-transactional put.")),
    queryRecords: async (table, input) => {
      queries.push(input as Record<string, unknown>);
      const values = input.ExpressionAttributeValues as Record<string, string>;
      const condition = input.KeyConditionExpression;
      const inRange =
        condition === "#gsi1pk = :partition AND begins_with(#gsi1sk, :prefix)"
          ? (sortKey: string) => sortKey.startsWith(values[":prefix"]!)
          : condition === "#gsi1pk = :partition AND #gsi1sk < :before"
            ? (sortKey: string) => sortKey < values[":before"]!
            : undefined;
      if (input.IndexName !== "gsi1" || !inRange || input.ScanIndexForward !== false) {
        throw new Error(`Unsupported identity query: ${String(condition)}`);
      }
      const matches = [...records.entries()]
        .filter(([storedKey]) => storedKey.startsWith(`${table}\u0000`))
        .map(([, record]) => record)
        .filter(
          (record) =>
            record.gsi1pk === values[":partition"] &&
            record.gsi1sk !== undefined &&
            inRange(record.gsi1sk),
        )
        .sort((left, right) => (left.gsi1sk! < right.gsi1sk! ? 1 : -1));
      const limit = input.Limit ?? matches.length;
      const items = matches.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        ...(matches.length > limit && last
          ? { lastEvaluatedKey: { pk: last.pk, sk: last.sk } }
          : {}),
      };
    },
    transactWrite: async (operations) => {
      const writes: PlatformRecord[] = [];
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        const record = await Effect.runPromise(decodePlatformRecord(operation.record));
        const table = tableForItemType(record.itemType);
        const existing = records.get(storageKey(table, record.pk, record.sk));
        const stale = operation.previousRecord
          ? versionOf(existing) !== versionOf(operation.previousRecord)
          : existing !== undefined;
        if (stale) throw conflict(`Stale ${record.itemType} write.`);
        writes.push(record);
      }
      writes.forEach(store);
    },
  };

  return {
    get: (table: TableName, pk: string, sk: string) => records.get(storageKey(table, pk, sk)),
    queries,
    repository: makeIdentityRepository(database),
  };
}

export function principalSeed(principalId: Ulid, sessionEpoch = 0) {
  return [
    principalRecord({
      createdAt: CREATED_AT,
      id: principalId,
      primaryEmail: `${principalId}@x.io`,
    }),
    securityStateRecord({
      createdAt: CREATED_AT,
      credentialVersion: 1,
      emailVerifiedAt: CREATED_AT,
      principalId,
      sessionEpoch,
      version: 1,
    }),
  ];
}

export function browserSession(input: {
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly id: Ulid;
  readonly idleExpiresAt?: string;
  readonly principalId: Ulid;
  readonly rawToken: string;
  readonly sessionEpoch?: number;
}) {
  return sessionRecords({
    authentication: { method: "password" },
    authenticationTime: input.createdAt,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt ?? "2026-08-27T00:00:00.000Z",
    id: input.id,
    idleExpiresAt: input.idleExpiresAt ?? "2026-07-29T00:00:00.000Z",
    principalId: input.principalId,
    sessionEpoch: input.sessionEpoch ?? 0,
    tokenHash: sha256(input.rawToken),
  });
}

export function sequentialIds() {
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let next = 0;
  return () => {
    const index = next++;
    return `01ARZ3NDEKTSV4RRFFQ69G5G${crockford[Math.floor(index / 32)]}${crockford[index % 32]}` as Ulid;
  };
}

export function identityApplication(repository: IdentityRepository, generateId = sequentialIds()) {
  return makeIdentityApplication(
    {
      encryptEmailPayload: async () => {
        throw new Error("Unexpected email encryption.");
      },
      generateId,
      now: () => new Date(NOW),
      repository,
    },
    {
      actionLifetimeSeconds: 1_800,
      sessionAbsoluteLifetimeSeconds: 30 * 86_400,
      sessionIdleLifetimeSeconds: 86_400,
    },
  );
}
