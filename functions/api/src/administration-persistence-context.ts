import { CredentialVaultError } from "@deployments-ai/credential-vault";
import {
  PersistenceError,
  MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION,
  Ulid,
  isDatabaseWriteConflict,
  key,
  makeIdGenerator,
  makeProviderConnectionPersistence,
  withCanonicalRecordKeys,
  type TransactionOperation,
  apiPersistence,
} from "@deployments-ai/db";
import { codeProviderDefinitionRegistry } from "@deployments-ai/providers";
import { createHash } from "node:crypto";
import type { AdministrationInvocation } from "./administration-api.ts";
import { errorLogFields } from "./error-log-fields.ts";

import {
  asObject,
  expectedVersion,
  id,
  recordOperations,
  resourceId,
  text,
  vaultReference,
  type AdministrationPersistenceDependencies,
  type EnvironmentItemType,
  type EnvironmentRecord,
} from "./administration-persistence-contracts.ts";
import { decodeCursor, encodeCursor, projection } from "./administration-record-mapping.ts";
import { providerProjection } from "./provider-projection.ts";

/** Tool-adapter execution types exposed through `/v1/extensions` (vendor MCP tools are synced). */
const PUBLIC_EXTENSION_EXECUTION_TYPES: Readonly<Record<string, true>> = {
  client: true,
  hosted_code: true,
  http_callback: true,
  mcp: true,
  vendor_mcp: true,
};

export function publicExtensionExecution(execution: Readonly<Record<string, unknown>>): boolean {
  const { type } = execution;
  return typeof type === "string" && Object.hasOwn(PUBLIC_EXTENSION_EXECUTION_TYPES, type);
}

export function makeAdministrationPersistenceContext(
  dependencies: AdministrationPersistenceDependencies,
) {
  const generator = makeIdGenerator();
  const generateId = dependencies.generateId ?? (async () => generator.generate());
  const now = dependencies.now ?? (() => new Date());
  const providers = dependencies.providers ?? codeProviderDefinitionRegistry();
  const providerConnections = makeProviderConnectionPersistence(dependencies.database);

  function transactionToken(
    invocation: AdministrationInvocation,
    operation: string,
    operations: readonly TransactionOperation[],
  ) {
    if (!invocation.idempotencyKey) return undefined;
    return createHash("sha256")
      .update(
        [
          invocation.identity?.principalId ?? "anonymous",
          invocation.scope.environmentId ?? "",
          operation,
          invocation.idempotencyKey,
          createHash("sha256").update(JSON.stringify(operations)).digest("hex"),
        ].join("\u0000"),
      )
      .digest("hex")
      .slice(0, 36);
  }

  async function databaseValue<A>(operation: Promise<A>): Promise<A> {
    try {
      return await operation;
    } catch (cause) {
      if (cause instanceof PersistenceError) throw cause;
      if (isDatabaseWriteConflict(cause)) {
        throw new PersistenceError(
          "conflict",
          "version_conflict",
          "The resource changed concurrently.",
        );
      }
      console.error("Administration persistence failed.", errorLogFields(cause));
      throw new PersistenceError(
        "internal",
        "persistence_error",
        "Administration persistence failed.",
      );
    }
  }

  async function credentialValue<A>(operation: () => Promise<A>): Promise<A> {
    try {
      return await operation();
    } catch (cause) {
      if (!(cause instanceof CredentialVaultError)) throw cause;
      if (cause.code === "conflict" || cause.code === "revoked") {
        throw new PersistenceError("conflict", "credential_conflict", cause.message);
      }
      if (cause.code === "not-found") {
        throw new PersistenceError("not-found", "credential_not_found", cause.message);
      }
      if (cause.code === "invalid-input") {
        throw new PersistenceError("invalid-input", "invalid_credential", cause.message);
      }
      throw new PersistenceError(
        "internal",
        "credential_vault_error",
        "Credential vault operation failed.",
      );
    }
  }

  async function environment(invocation: AdministrationInvocation) {
    const resolved = await dependencies.resolveEnvironment(invocation);
    if (!resolved || resolved.id !== invocation.scope.environmentId) {
      throw new PersistenceError("not-found", "resource_not_found", "Environment was not found.");
    }
    if (resolved.status !== "active") {
      throw new PersistenceError(
        "unprocessable",
        "environment_inactive",
        "Administration requires an active environment.",
      );
    }
    return resolved;
  }

  async function getRecord(
    invocation: AdministrationInvocation,
    itemType: EnvironmentItemType,
    explicitId?: Ulid,
  ): Promise<EnvironmentRecord> {
    const scope = await environment(invocation);
    const record = await databaseValue(
      apiPersistence.read(
        dependencies.database,
        "control",
        {
          pk: key("ORG", scope.organizationId, "ENV", scope.id),
          sk: key(itemType.toUpperCase(), explicitId ?? resourceId(invocation)),
        },
        true,
      ),
    );
    if (!record || record.itemType !== itemType) {
      throw new PersistenceError("not-found", "resource_not_found", "Resource was not found.");
    }
    return record as EnvironmentRecord;
  }

  async function listRecords(
    invocation: AdministrationInvocation,
    itemType: EnvironmentItemType,
    predicate: (record: EnvironmentRecord) => boolean = () => true,
  ) {
    const scope = await environment(invocation);
    const exclusiveStartKey = decodeCursor(invocation.query.cursor, scope.id, itemType);
    const result = await databaseValue(
      apiPersistence.find(dependencies.database, "control", {
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        ExpressionAttributeValues: {
          ":partition": key("ENV", scope.id),
          ":prefix": `${key(itemType.toUpperCase())}#`,
        },
        IndexName: "gsi2",
        KeyConditionExpression: "gsi2pk = :partition AND begins_with(gsi2sk, :prefix)",
        Limit: invocation.query.limit ?? 50,
      }),
    );
    return {
      items: result.items
        .filter((record): record is EnvironmentRecord => record.itemType === itemType)
        .filter(predicate)
        .map(projection),
      nextCursor: result.lastEvaluatedKey
        ? encodeCursor(result.lastEvaluatedKey, scope.id, itemType)
        : null,
    };
  }

  async function listAllRecords(
    invocation: AdministrationInvocation,
    itemType: EnvironmentItemType,
    predicate: (record: EnvironmentRecord) => boolean = () => true,
  ) {
    const items: Readonly<Record<string, unknown>>[] = [];
    let cursor: string | undefined;
    do {
      const page = await listRecords(
        { ...invocation, query: { ...(cursor ? { cursor } : {}), limit: 100 } },
        itemType,
        predicate,
      );
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }

  async function listAllRecordsConsistently(
    invocation: AdministrationInvocation,
    itemType: EnvironmentItemType,
    predicate: (record: EnvironmentRecord) => boolean = () => true,
  ) {
    const scope = await environment(invocation);
    const items: EnvironmentRecord[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await databaseValue(
        apiPersistence.find(dependencies.database, "control", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ConsistentRead: true,
          ExpressionAttributeValues: {
            ":partition": key("ORG", scope.organizationId, "ENV", scope.id),
            ":prefix": `${key(itemType.toUpperCase())}#`,
          },
          KeyConditionExpression: "pk = :partition AND begins_with(sk, :prefix)",
          Limit: 100,
        }),
      );
      items.push(
        ...page.items
          .filter((record): record is EnvironmentRecord => record.itemType === itemType)
          .filter(predicate),
      );
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  async function listProviders(invocation: AdministrationInvocation) {
    const scopeId = "00000000000000000000000000" as Ulid;
    const cursor = decodeCursor(invocation.query.cursor, scopeId, "provider-definition");
    const offset =
      cursor?.offset === undefined
        ? 0
        : Number.isSafeInteger(cursor.offset) && Number(cursor.offset) >= 0
          ? Number(cursor.offset)
          : -1;
    if (offset < 0) {
      throw new PersistenceError(
        "invalid-input",
        "invalid_cursor",
        "The pagination cursor is invalid.",
      );
    }
    const limit = invocation.query.limit ?? 50;
    const definitions = providers.list();
    const nextOffset = offset + limit;
    return {
      items: definitions.slice(offset, nextOffset).map(providerProjection),
      nextCursor:
        nextOffset < definitions.length
          ? encodeCursor({ offset: nextOffset }, scopeId, "provider-definition")
          : null,
    };
  }

  async function getProvider(invocation: AdministrationInvocation) {
    const providerKey = text(invocation.params.providerKey ?? invocation.id, "providerKey");
    const definition = providers.resolve(providerKey);
    if (!definition) {
      throw new PersistenceError("not-found", "resource_not_found", "Provider was not found.");
    }
    return providerProjection(definition);
  }

  function providerDefinition(providerKey: unknown) {
    const requested = text(providerKey, "providerKey");
    const definition = providers.resolve(requested);
    if (!definition || definition.status !== "configured") {
      throw new PersistenceError(
        "unprocessable",
        "provider_unavailable",
        "Provider is unavailable.",
      );
    }
    return definition;
  }

  function assertScopes(
    requested: readonly string[],
    supported: readonly string[],
    label = "Requested scopes",
  ) {
    if (requested.some((scope) => !supported.includes(scope))) {
      throw new PersistenceError(
        "unprocessable",
        "invalid_scope",
        `${label} must be a subset of provider-supported scopes.`,
      );
    }
  }

  function callbackAuthorizationHeader(value: unknown) {
    const header = `Bearer ${text(value, "callbackSecret")}`;
    if (
      Array.from(header).some((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint <= 0x1f || codePoint === 0x7f;
      })
    ) {
      throw new PersistenceError(
        "unprocessable",
        "invalid_callback_auth",
        "Callback authentication is invalid.",
      );
    }
    return header;
  }

  function staticProviderConnection(record: EnvironmentRecord) {
    return (
      record.itemType === "provider-connection" &&
      !["oauth", "oauth2"].includes(record.data.authMethod.toLowerCase())
    );
  }

  async function revokeProviderCredential(invocation: AdministrationInvocation) {
    const connection = await getRecord(invocation, "provider-connection");
    if (!staticProviderConnection(connection)) {
      throw new PersistenceError(
        "unprocessable",
        "invalid_auth_method",
        "OAuth connections must be revoked through the connection endpoint.",
      );
    }
    return statusChange(invocation, "provider-connection", "disconnected", "credentialRef");
  }

  async function getAdapterByName(invocation: AdministrationInvocation) {
    const name = text(invocation.params.toolName ?? invocation.id, "toolName");
    const adapters = await listAllRecordsConsistently(invocation, "tool-adapter", (record) => {
      return (
        record.itemType === "tool-adapter" &&
        record.data.name === name &&
        record.data.status === "active" &&
        publicExtensionExecution(record.data.execution)
      );
    });
    const match = adapters[0];
    if (match) return match;
    throw new PersistenceError("not-found", "resource_not_found", "Extension tool was not found.");
  }

  async function adapterInvocation(invocation: AdministrationInvocation) {
    const adapter = await getAdapterByName(invocation);
    return { ...invocation, id: id(String(adapter.data.id)) };
  }

  async function write(
    invocation: AdministrationInvocation,
    operations: readonly TransactionOperation[],
    operation: string,
  ) {
    try {
      await apiPersistence.commit(
        dependencies.database,
        operations,
        transactionToken(invocation, operation, operations),
      );
    } catch (cause) {
      if (cause instanceof PersistenceError) throw cause;
      if (isDatabaseWriteConflict(cause)) {
        throw new PersistenceError(
          "conflict",
          "version_conflict",
          "The resource changed concurrently.",
        );
      }
      throw new PersistenceError(
        "internal",
        "ambiguous_write_outcome",
        "The administration write outcome could not be confirmed.",
      );
    }
  }

  async function createCredentiallessProviderConnection(
    invocation: AdministrationInvocation,
    connection: Extract<EnvironmentRecord, { readonly itemType: "provider-connection" }>,
    capability: Extract<EnvironmentRecord, { readonly itemType: "connection-capability" }>,
    eventId: Ulid,
    timestamp: string,
  ) {
    try {
      await providerConnections.createCredentialless({
        capability,
        connection,
        eventId,
        ...(invocation.idempotencyKey
          ? {
              idempotency: {
                environmentId: connection.data.environmentId,
                key: invocation.idempotencyKey,
                operation: "provider-connection.create",
                principalId: invocation.identity?.principalId ?? "anonymous",
              },
            }
          : {}),
        occurredAt: timestamp,
      });
    } catch (cause) {
      if (cause instanceof PersistenceError) throw cause;
      if (isDatabaseWriteConflict(cause)) {
        throw new PersistenceError(
          "conflict",
          "version_conflict",
          "The resource changed concurrently.",
        );
      }
      throw new PersistenceError(
        "internal",
        "ambiguous_write_outcome",
        "The administration write outcome could not be confirmed.",
      );
    }
  }

  async function disconnectProviderConnection(
    invocation: AdministrationInvocation,
    previousConnection: Extract<EnvironmentRecord, { readonly itemType: "provider-connection" }>,
    connection: Extract<EnvironmentRecord, { readonly itemType: "provider-connection" }>,
    additionalOperations: readonly TransactionOperation[],
    timestamp: string,
  ) {
    try {
      await providerConnections.disconnect({
        additionalOperations,
        connection,
        eventId: id(await generateId()),
        ...(invocation.idempotencyKey
          ? {
              idempotency: {
                environmentId: connection.data.environmentId,
                key: invocation.idempotencyKey,
                operation: "provider-connection.status",
                principalId: invocation.identity?.principalId ?? "anonymous",
              },
            }
          : {}),
        occurredAt: timestamp,
        previousConnection,
      });
    } catch (cause) {
      if (cause instanceof PersistenceError) throw cause;
      if (isDatabaseWriteConflict(cause)) {
        throw new PersistenceError(
          "conflict",
          "version_conflict",
          "The resource changed concurrently.",
        );
      }
      throw new PersistenceError(
        "internal",
        "ambiguous_write_outcome",
        "The administration write outcome could not be confirmed.",
      );
    }
  }

  async function statusChange(
    invocation: AdministrationInvocation,
    itemType: EnvironmentItemType,
    status: string,
    referenceField?: "authSecretRef" | "clientSecretRef" | "credentialRef",
  ) {
    const previous = await getRecord(invocation, itemType);
    const body = asObject(invocation.body ?? {});
    const resuming =
      itemType === "provider-connection" &&
      status === "disconnected" &&
      previous.data.status === status;
    if (!resuming) expectedVersion(body, previous.data.version);
    const timestamp = now().toISOString();
    const data = previous.data as Record<string, unknown>;
    const operations: TransactionOperation[] = [];
    const dependentOperations: TransactionOperation[] = [];
    if (!resuming && referenceField && data[referenceField]) {
      operations.push(
        (
          await credentialValue(() =>
            dependencies.credentials.prepareRevoke({
              environmentId: data.environmentId as Ulid,
              organizationId: data.organizationId as Ulid,
              reference: vaultReference(data[referenceField]),
            }),
          )
        ).operation,
      );
    }
    let next = previous as EnvironmentRecord;
    if (!resuming) {
      next = withCanonicalRecordKeys({
        itemType,
        data: {
          ...data,
          status,
          updatedAt: timestamp,
          version: previous.data.version + 1,
        },
      }) as EnvironmentRecord;
      try {
        if (
          previous.itemType === "provider-connection" &&
          next.itemType === "provider-connection" &&
          status === "disconnected"
        ) {
          await disconnectProviderConnection(invocation, previous, next, operations, timestamp);
        } else {
          operations.push(...recordOperations(next, timestamp, previous));
          await write(invocation, operations, `${itemType}.status`);
        }
      } catch (cause) {
        if (
          itemType !== "provider-connection" ||
          status !== "disconnected" ||
          !(cause instanceof PersistenceError) ||
          cause.kind !== "internal" ||
          cause.code !== "ambiguous_write_outcome"
        ) {
          throw cause;
        }
        let current: EnvironmentRecord;
        try {
          current = await getRecord(invocation, itemType, previous.data.id);
        } catch {
          throw cause;
        }
        if (current.data.status === status && current.data.version === next.data.version) {
          next = current;
        } else if (
          current.data.status === previous.data.status &&
          current.data.version === previous.data.version
        ) {
          throw new PersistenceError(
            "internal",
            "persistence_error",
            "Connection disconnection can be retried with the same idempotency key.",
          );
        } else {
          throw cause;
        }
      }
    }
    if (itemType === "provider-connection" && status === "disconnected") {
      const dependents = await Promise.all([
        listAllRecordsConsistently(
          invocation,
          "connection-capability",
          (record) =>
            record.itemType === "connection-capability" &&
            record.data.connectionId === previous.data.id &&
            record.data.status === "active",
        ),
        listAllRecordsConsistently(
          invocation,
          "workspace-connection-authorization",
          (record) =>
            record.itemType === "workspace-connection-authorization" &&
            record.data.connectionId === previous.data.id &&
            record.data.status === "active",
        ),
      ]);
      for (const candidates of dependents) {
        for (const candidate of candidates) {
          const dependent = candidate;
          const nextDependent = withCanonicalRecordKeys({
            itemType: dependent.itemType,
            data: {
              ...dependent.data,
              status: dependent.itemType === "connection-capability" ? "stale" : "revoked",
              updatedAt: timestamp,
              version: dependent.data.version + 1,
            },
          }) as EnvironmentRecord;
          dependentOperations.push(...recordOperations(nextDependent, timestamp, dependent));
        }
      }
    }
    for (
      let offset = 0;
      offset < dependentOperations.length;
      offset += MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION
    ) {
      const chunk = dependentOperations.slice(
        offset,
        offset + MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION,
      );
      const chunkKey = createHash("sha256")
        .update(
          JSON.stringify(
            chunk.map((operation) =>
              operation.kind === "condition-check"
                ? operation
                : {
                    kind: operation.kind,
                    pk: operation.record.pk,
                    sk: operation.record.sk,
                  },
            ),
          ),
        )
        .digest("hex")
        .slice(0, 16);
      try {
        await write(invocation, chunk, `${itemType}.dependents.${chunkKey}`);
      } catch (cause) {
        if (
          itemType === "provider-connection" &&
          status === "disconnected" &&
          cause instanceof PersistenceError &&
          cause.kind === "internal" &&
          cause.code === "ambiguous_write_outcome"
        ) {
          throw new PersistenceError(
            "internal",
            "persistence_error",
            "Connection dependent cleanup can be retried with the same idempotency key.",
          );
        }
        throw cause;
      }
    }
    return projection(next);
  }
  return {
    dependencies,
    generator,
    generateId,
    now,
    providers,
    transactionToken,
    databaseValue,
    credentialValue,
    environment,
    getRecord,
    listRecords,
    listAllRecords,
    listAllRecordsConsistently,
    providerProjection,
    listProviders,
    getProvider,
    providerDefinition,
    assertScopes,
    callbackAuthorizationHeader,
    staticProviderConnection,
    revokeProviderCredential,
    getAdapterByName,
    adapterInvocation,
    write,
    createCredentiallessProviderConnection,
    statusChange,
  };
}

export type AdministrationPersistenceContext = ReturnType<
  typeof makeAdministrationPersistenceContext
>;
