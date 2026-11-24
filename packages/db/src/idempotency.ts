import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { DynamoDatabaseService, TransactionOperation } from "./client-types.ts";
import { PersistenceError } from "./persistence-types.ts";
import { IdempotencyRecord } from "./records/events.ts";
import { type PlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";
import {
  expiredIdempotencyReplacementCondition,
  isDatabaseWriteConflict,
} from "./transaction-conditions.ts";

type IdempotencyRecordValue = Extract<PlatformRecord, { readonly itemType: "idempotency" }>;
type Acquisition =
  | { readonly kind: "acquired" }
  | { readonly kind: "replayed"; readonly value: unknown };

export interface IdempotencyExecution {
  readonly completionOperations?: (result: unknown) => readonly TransactionOperation[];
  readonly fingerprint: string;
  readonly key: string;
  /**
   * How long an unfinished attempt blocks resends of the same key. Set it only when the host
   * stops the attempt before the lease ends and running the operation again is safe.
   */
  readonly inProgressLeaseSeconds?: number;
  readonly operation: () => Promise<unknown>;
  readonly organizationId?: string;
  readonly principalId: string;
  readonly resolveOrganizationId?: (result: unknown) => string | undefined;
}

export interface IdempotencyPersistence {
  execute(input: IdempotencyExecution): Promise<unknown>;
}

export interface IdempotencyResponseContext {
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  readonly principalId: string;
}

export interface IdempotencyResponseProtector {
  prepare(context: IdempotencyResponseContext): Promise<{
    readonly dispose: () => void;
    readonly protect: (value: unknown) => Promise<Readonly<Record<string, unknown>>>;
  }>;
  unprotect(
    value: Readonly<Record<string, unknown>>,
    context: IdempotencyResponseContext,
  ): Promise<unknown>;
}

export interface IdempotencyPersistenceDependencies {
  readonly database: DynamoDatabaseService;
  readonly now?: () => Date;
  readonly responseProtector: IdempotencyResponseProtector;
  readonly ttlSeconds?: number;
}

function identity(principalId: string, keyValue: string) {
  return createHash("sha256")
    .update(JSON.stringify([principalId, keyValue]))
    .digest("hex");
}

function idempotencyRecord(input: {
  readonly createdAt: Date;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  readonly organizationId?: string;
  readonly principalScoped?: boolean;
  readonly principalId: string;
  readonly response?: Readonly<Record<string, unknown>>;
  readonly responseEncoding?: "envelope-v1" | "protected-envelope-v1";
  readonly resourceIds?: readonly string[];
  readonly status: "completed" | "in-progress";
  readonly ttlSeconds: number;
  readonly version: number;
}) {
  const expiresAt = new Date(input.createdAt.getTime() + input.ttlSeconds * 1_000);
  return Schema.decodeUnknownSync(IdempotencyRecord)(
    withCanonicalRecordKeys({
      data: {
        commandHash: input.fingerprint,
        createdAt: input.createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        idempotencyKey: input.idempotencyKey,
        ...(input.principalScoped
          ? {
              ...(input.organizationId ? { organizationId: input.organizationId } : {}),
              principalId: input.principalId,
            }
          : input.organizationId
            ? { organizationId: input.organizationId }
            : { principalId: input.principalId }),
        resourceIds: input.resourceIds ?? [],
        ...(input.response ? { response: input.response } : {}),
        ...(input.responseEncoding ? { responseEncoding: input.responseEncoding } : {}),
        status: input.status,
        version: input.version,
      },
      itemType: "idempotency" as const,
      ttl: Math.floor(expiresAt.getTime() / 1_000),
    }),
  );
}

function persistenceFailure() {
  return new PersistenceError("internal", "persistence_error", "Idempotency persistence failed.");
}

async function existing(database: DynamoDatabaseService, candidate: IdempotencyRecordValue) {
  try {
    return await database.getRecord("events", { pk: candidate.pk, sk: candidate.sk }, true);
  } catch {
    throw persistenceFailure();
  }
}

async function replay(
  record: PlatformRecord,
  fingerprint: string,
  protector: IdempotencyResponseProtector,
  context: IdempotencyResponseContext,
) {
  if (record.itemType !== "idempotency") {
    throw persistenceFailure();
  }
  if (record.data.commandHash !== fingerprint) {
    throw new PersistenceError(
      "conflict",
      "idempotency_conflict",
      "The idempotency key was already used for a different request.",
    );
  }
  if (record.data.status === "completed" && record.data.response !== undefined) {
    if (record.data.responseEncoding === "envelope-v1") {
      return record.data.response.kind === "undefined" ? undefined : record.data.response.value;
    }
    if (record.data.responseEncoding === "protected-envelope-v1") {
      try {
        return await protector.unprotect(record.data.response, context);
      } catch {
        throw persistenceFailure();
      }
    }
    return record.data.response;
  }
  throw new PersistenceError(
    "conflict",
    "idempotency_in_progress",
    "A request with this idempotency key is already in progress.",
  );
}

async function acquire(
  database: DynamoDatabaseService,
  pending: IdempotencyRecordValue,
  fingerprint: string,
  protector: IdempotencyResponseProtector,
  context: IdempotencyResponseContext,
): Promise<Acquisition> {
  try {
    await database.transactWrite([
      {
        ...expiredIdempotencyReplacementCondition(pending),
        kind: "put",
        record: pending,
        replaceExpired: true,
      },
    ]);
  } catch (cause) {
    if (!isDatabaseWriteConflict(cause)) throw persistenceFailure();
    const winner = await existing(database, pending);
    if (winner) {
      return {
        kind: "replayed",
        value: await replay(winner, fingerprint, protector, context),
      };
    }
    throw persistenceFailure();
  }
  return { kind: "acquired" };
}

async function release(database: DynamoDatabaseService, pending: IdempotencyRecordValue) {
  try {
    await database.transactWrite([{ kind: "delete", record: pending }]);
  } catch {
    // The expiring in-progress record safely blocks an immediate duplicate.
  }
}

async function complete(
  database: DynamoDatabaseService,
  pending: IdempotencyRecordValue,
  completed: IdempotencyRecordValue,
  completionOperations: readonly TransactionOperation[],
) {
  const retryDelays = [0, 25, 100] as const;
  for (const retryDelay of retryDelays) {
    if (retryDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
    try {
      await database.transactWrite([
        { kind: "put", previousRecord: pending, record: completed },
        ...completionOperations,
      ]);
      return;
    } catch {
      try {
        const found = await existing(database, completed);
        if (
          found?.itemType === "idempotency" &&
          found.data.status === "completed" &&
          found.data.commandHash === completed.data.commandHash
        ) {
          return;
        }
      } catch {
        // Retry the completion write when its outcome cannot be read back.
      }
    }
  }
  throw persistenceFailure();
}

export function makeIdempotencyPersistence(
  dependencies: IdempotencyPersistenceDependencies,
): IdempotencyPersistence {
  const now = dependencies.now ?? (() => new Date());
  const ttlSeconds = dependencies.ttlSeconds ?? 24 * 60 * 60;
  return {
    async execute(input) {
      const createdAt = now();
      const idempotencyKey = `agent-api:${identity(input.principalId, input.key)}`;
      const responseContext = {
        fingerprint: input.fingerprint,
        idempotencyKey,
        principalId: input.principalId,
      };
      const pending = idempotencyRecord({
        createdAt,
        fingerprint: input.fingerprint,
        idempotencyKey,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        principalScoped: input.organizationId === undefined,
        principalId: input.principalId,
        status: "in-progress",
        ttlSeconds: input.inProgressLeaseSeconds ?? ttlSeconds,
        version: 0,
      });
      const found = await existing(dependencies.database, pending);
      if (
        found?.itemType === "idempotency" &&
        Date.parse(found.data.expiresAt) > createdAt.getTime()
      ) {
        return replay(found, input.fingerprint, dependencies.responseProtector, responseContext);
      }
      const acquisition = await acquire(
        dependencies.database,
        pending,
        input.fingerprint,
        dependencies.responseProtector,
        responseContext,
      );
      if (acquisition.kind === "replayed") return acquisition.value;

      let preparedProtection: Awaited<ReturnType<IdempotencyResponseProtector["prepare"]>>;
      try {
        preparedProtection = await dependencies.responseProtector.prepare(responseContext);
      } catch {
        await release(dependencies.database, pending);
        throw persistenceFailure();
      }
      let result: unknown;
      try {
        result = await input.operation();
      } catch (cause) {
        preparedProtection.dispose();
        if (
          !(cause instanceof PersistenceError) ||
          cause.kind !== "internal" ||
          cause.code !== "ambiguous_write_outcome"
        ) {
          await release(dependencies.database, pending);
        }
        throw cause;
      }
      let protectedResponse: Readonly<Record<string, unknown>>;
      try {
        protectedResponse = await preparedProtection.protect(result);
      } catch {
        // The operation already committed, so retaining the expiring pending record is the
        // only safe at-most-once outcome when local response encoding unexpectedly fails.
        throw persistenceFailure();
      } finally {
        preparedProtection.dispose();
      }
      const completed = idempotencyRecord({
        createdAt,
        fingerprint: input.fingerprint,
        idempotencyKey,
        ...(() => {
          const organizationId = input.organizationId ?? input.resolveOrganizationId?.(result);
          return organizationId ? { organizationId } : {};
        })(),
        principalScoped: input.organizationId === undefined,
        principalId: input.principalId,
        response: protectedResponse,
        responseEncoding: "protected-envelope-v1",
        ...(result &&
        typeof result === "object" &&
        "id" in result &&
        typeof result.id === "string" &&
        /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(result.id)
          ? { resourceIds: [result.id] }
          : {}),
        status: "completed",
        ttlSeconds,
        version: 1,
      });
      let completionOperations: readonly TransactionOperation[];
      try {
        completionOperations = input.completionOperations?.(result) ?? [];
      } catch {
        throw persistenceFailure();
      }
      await complete(dependencies.database, pending, completed, completionOperations);
      return result;
    },
  };
}
