import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { Effect, Schema } from "effect";

import { CredentialVaultEntryRecord } from "../records/control.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { key, organizationWriteConditionChecks } from "../keys.ts";
import { governanceInventoryLayout } from "../governance-inventory-layout.ts";
import { governanceTenantDirectoryPutItem } from "../governance-tenant-directory.ts";

import {
  CredentialDataKeyCache,
  decryptCredentialDocument,
  encryptCredentialDocument,
} from "./crypto.ts";
import {
  CREDENTIAL_VAULT_SCHEMA_VERSION,
  CREDENTIAL_VAULT_STORE,
  CredentialVaultError,
  type CredentialVaultConfig,
  type CredentialVaultReferenceRequest,
  type CredentialVaultSecretDocument,
  type CredentialVaultService,
  type CredentialVaultWriteRequest,
} from "./types.ts";
import {
  credentialVaultEncryptionContext,
  credentialVaultEncryptionContextHash,
  normalizeCredentialVaultIdentity,
  normalizeCredentialVaultSecret,
} from "./validation.ts";

type CredentialVaultEntry = typeof CredentialVaultEntryRecord.Type;

function recordKey(organizationId: string, environmentId: string, credentialId: string) {
  return {
    pk: key("ORG", organizationId, "ENV", environmentId),
    sk: key("CREDENTIAL-VAULT-ENTRY", credentialId),
  };
}

function storageError(cause: unknown, transactionWriteIndex?: number) {
  if (cause instanceof CredentialVaultError) return cause;
  const name = cause && typeof cause === "object" && "name" in cause ? String(cause.name) : "";
  const cancellationReasons =
    cause && typeof cause === "object" && "CancellationReasons" in cause
      ? cause.CancellationReasons
      : undefined;
  const transactionWriteConflict =
    name === "TransactionCanceledException" &&
    transactionWriteIndex !== undefined &&
    (!Array.isArray(cancellationReasons) ||
      cancellationReasons.length === 0 ||
      (cancellationReasons[transactionWriteIndex] as { Code?: unknown } | undefined)?.Code ===
        "ConditionalCheckFailed");
  if (name === "ConditionalCheckFailedException" || transactionWriteConflict) {
    return new CredentialVaultError("conflict", "Credential generation changed concurrently.");
  }
  return new CredentialVaultError("storage", "Credential vault storage operation failed.", {
    cause,
  });
}

async function decodeEntry(value: unknown) {
  return Effect.runPromise(
    Schema.decodeUnknownEffect(CredentialVaultEntryRecord)(value).pipe(
      Effect.mapError(
        (cause) =>
          new CredentialVaultError("storage", "Credential vault item is invalid.", { cause }),
      ),
    ),
  );
}

function parseDocument(raw: string): CredentialVaultSecretDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new CredentialVaultError("crypto", "Credential document is invalid JSON.", { cause });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CredentialVaultError("crypto", "Credential document must be an object.");
  }
  const document = value as Partial<CredentialVaultSecretDocument>;
  if (
    document.schemaVersion !== CREDENTIAL_VAULT_SCHEMA_VERSION ||
    !Number.isSafeInteger(document.generation) ||
    !document.createdAt ||
    !document.updatedAt ||
    !document.values
  ) {
    throw new CredentialVaultError("crypto", "Credential document metadata is invalid.");
  }
  return document as CredentialVaultSecretDocument;
}

export function makeCredentialVault(config: CredentialVaultConfig): CredentialVaultService {
  const cache = new CredentialDataKeyCache(config.dataKeyCacheTtlMs, config.dataKeyCacheMaxEntries);

  async function storedEntry(request: CredentialVaultReferenceRequest) {
    const response = await config.documentClient.send(
      new GetCommand({
        ConsistentRead: true,
        Key: recordKey(
          request.organizationId,
          request.environmentId,
          request.reference.credentialId,
        ),
        TableName: config.tableName,
      }),
    );
    if (!response.Item) throw new CredentialVaultError("not-found", "Credential was not found.");
    const entry = await decodeEntry(response.Item);
    if (
      entry.data.organizationId !== request.organizationId ||
      entry.data.environmentId !== request.environmentId
    ) {
      throw new CredentialVaultError("not-found", "Credential was not found.");
    }
    return entry;
  }

  function assertReferenceState(
    entry: CredentialVaultEntry,
    request: CredentialVaultReferenceRequest,
  ) {
    if (entry.data.status === "revoked") {
      throw new CredentialVaultError("revoked", "Credential has been revoked.");
    }
    if (
      entry.ttl !== undefined &&
      entry.data.expiresAt &&
      Date.parse(entry.data.expiresAt) <= Date.now()
    ) {
      throw new CredentialVaultError("revoked", "Credential has expired.");
    }
    if (entry.data.generation !== request.reference.generation) {
      throw new CredentialVaultError(
        "conflict",
        "Credential generation no longer matches the pinned reference.",
      );
    }
  }

  async function entryFor(request: CredentialVaultReferenceRequest) {
    const entry = await storedEntry(request);
    assertReferenceState(entry, request);
    return entry;
  }

  async function prepareWrite(request: CredentialVaultWriteRequest) {
    const identity = normalizeCredentialVaultIdentity(request.identity);
    const secret = normalizeCredentialVaultSecret(request.secret);
    const now = new Date().toISOString();
    const generation = (request.expectedGeneration ?? -1) + 1;
    let createdAt = now;
    let previousRecord: CredentialVaultEntry | undefined;
    if (request.expectedGeneration !== undefined) {
      const existingResponse = await config.documentClient.send(
        new GetCommand({
          ConsistentRead: true,
          Key: recordKey(identity.organizationId, identity.environmentId, identity.credentialId),
          TableName: config.tableName,
        }),
      );
      if (!existingResponse.Item) {
        throw new CredentialVaultError("not-found", "Credential was not found for rotation.");
      }
      const existing = await decodeEntry(existingResponse.Item);
      if (
        existing.data.generation !== request.expectedGeneration ||
        existing.data.status !== "active"
      ) {
        throw new CredentialVaultError("conflict", "Credential generation changed concurrently.");
      }
      if (
        existing.data.ownerId !== identity.ownerId ||
        existing.data.ownerType !== identity.ownerType ||
        existing.data.projectId !== identity.projectId ||
        existing.data.purpose !== identity.purpose ||
        existing.data.kmsKeyArn !== config.kmsKeyArn
      ) {
        throw new CredentialVaultError(
          "conflict",
          "Credential identity cannot change during rotation.",
        );
      }
      createdAt = existing.data.createdAt;
      previousRecord = existing;
    }
    const document: CredentialVaultSecretDocument = {
      ...secret,
      createdAt,
      generation,
      schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION,
      updatedAt: now,
    };
    const context = credentialVaultEncryptionContext(identity);
    const encrypted = await encryptCredentialDocument({
      context,
      kmsClient: config.kmsClient,
      kmsKeyArn: config.kmsKeyArn,
      plaintext: JSON.stringify(document),
    });
    const entry = withCanonicalRecordKeys({
      itemType: "credential-vault-entry" as const,
      ...(secret.expiresAt && identity.ownerType === "oauth-authorization-attempt"
        ? { ttl: Math.floor(Date.parse(secret.expiresAt) / 1_000) }
        : {}),
      data: {
        environmentId: identity.environmentId,
        id: identity.credentialId,
        organizationId: identity.organizationId,
        ownerId: identity.ownerId,
        ownerType: identity.ownerType,
        projectId: identity.projectId,
        purpose: identity.purpose,
        ...encrypted,
        createdAt,
        encryptionContextHash: credentialVaultEncryptionContextHash(context),
        ...(secret.expiresAt ? { expiresAt: secret.expiresAt } : {}),
        generation,
        kmsKeyArn: config.kmsKeyArn,
        status: "active" as const,
        updatedAt: now,
        version: generation,
      },
    }) as CredentialVaultEntry;
    return {
      operation: {
        ...(previousRecord === undefined
          ? { conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }
          : {}),
        kind: "put" as const,
        ...(previousRecord ? { previousRecord } : {}),
        record: entry,
      },
      reference: { credentialId: identity.credentialId, generation, store: CREDENTIAL_VAULT_STORE },
    };
  }

  async function prepareRevoke(request: CredentialVaultReferenceRequest) {
    const entry = await entryFor(request);
    const updatedAt = new Date().toISOString();
    const replacement = withCanonicalRecordKeys({
      itemType: "credential-vault-entry" as const,
      ...(entry.ttl === undefined ? {} : { ttl: entry.ttl }),
      data: {
        ...entry.data,
        status: "revoked" as const,
        updatedAt,
        version: entry.data.version + 1,
      },
    }) as CredentialVaultEntry;
    return {
      operation: { kind: "put" as const, previousRecord: entry, record: replacement },
      reference: request.reference,
    };
  }

  return {
    async prepareRevoke(request) {
      try {
        return await prepareRevoke(request);
      } catch (cause) {
        throw storageError(cause);
      }
    },

    async prepareWrite(request) {
      try {
        return await prepareWrite(request);
      } catch (cause) {
        throw storageError(cause);
      }
    },

    async read(request) {
      try {
        const entry = await storedEntry(request);
        const expected = request.expectedIdentity;
        if (
          entry.data.ownerId !== expected.ownerId ||
          entry.data.ownerType !== expected.ownerType ||
          entry.data.projectId !== expected.projectId ||
          entry.data.purpose !== expected.purpose
        ) {
          throw new CredentialVaultError("not-found", "Credential was not found.");
        }
        assertReferenceState(entry, request);
        const identity = {
          credentialId: entry.data.id,
          environmentId: entry.data.environmentId,
          organizationId: entry.data.organizationId,
          ownerId: entry.data.ownerId,
          ownerType: entry.data.ownerType,
          projectId: entry.data.projectId,
          purpose: entry.data.purpose,
        } as const;
        const context = credentialVaultEncryptionContext(identity);
        if (credentialVaultEncryptionContextHash(context) !== entry.data.encryptionContextHash) {
          throw new CredentialVaultError(
            "crypto",
            "Credential encryption context does not match storage metadata.",
          );
        }
        const raw = await decryptCredentialDocument({
          algorithm: entry.data.algorithm,
          authTag: entry.data.authTag,
          cache,
          ciphertext: entry.data.ciphertext,
          context,
          encryptedDataKey: entry.data.encryptedDataKey,
          iv: entry.data.iv,
          kmsClient: config.kmsClient,
          kmsKeyArn: entry.data.kmsKeyArn,
        });
        const document = parseDocument(raw);
        if (document.generation !== request.reference.generation) {
          throw new CredentialVaultError(
            "conflict",
            "Credential document generation does not match its reference.",
          );
        }
        return document;
      } catch (cause) {
        throw storageError(cause);
      }
    },

    async revoke(request) {
      try {
        const prepared = await prepareRevoke(request);
        const directoryPut = governanceTenantDirectoryPutItem(
          prepared.operation.record,
          config.tableName,
          await governanceInventoryLayout(config.documentClient, config.tableName),
        );
        if (!directoryPut) throw new Error("Credential revoke is missing tenant inventory scope.");
        await config.documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              ...organizationWriteConditionChecks(request.organizationId, config.tableName),
              {
                Put: {
                  ConditionExpression:
                    "#data.#generation = :generation AND #data.#status = :active",
                  ExpressionAttributeNames: {
                    "#data": "data",
                    "#generation": "generation",
                    "#status": "status",
                  },
                  ExpressionAttributeValues: {
                    ":active": "active",
                    ":generation": request.reference.generation,
                  },
                  Item: prepared.operation.record,
                  TableName: config.tableName,
                },
              },
              directoryPut,
            ],
          }),
        );
      } catch (cause) {
        throw storageError(cause, 2);
      }
    },

    async write(request: CredentialVaultWriteRequest) {
      try {
        const prepared = await prepareWrite(request);
        const directoryPut = governanceTenantDirectoryPutItem(
          prepared.operation.record,
          config.tableName,
          await governanceInventoryLayout(config.documentClient, config.tableName),
        );
        if (!directoryPut) throw new Error("Credential write is missing tenant inventory scope.");
        await config.documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              ...organizationWriteConditionChecks(
                request.identity.organizationId,
                config.tableName,
              ),
              {
                Put: {
                  ConditionExpression:
                    request.expectedGeneration === undefined
                      ? "attribute_not_exists(pk) AND attribute_not_exists(sk)"
                      : "#data.#generation = :expectedGeneration AND #data.#status = :active",
                  ...(request.expectedGeneration === undefined
                    ? {}
                    : {
                        ExpressionAttributeNames: {
                          "#data": "data",
                          "#generation": "generation",
                          "#status": "status",
                        },
                        ExpressionAttributeValues: {
                          ":active": "active",
                          ":expectedGeneration": request.expectedGeneration,
                        },
                      }),
                  Item: prepared.operation.record,
                  TableName: config.tableName,
                },
              },
              directoryPut,
            ],
          }),
        );
        return prepared.reference;
      } catch (cause) {
        throw storageError(cause, 2);
      }
    },
  };
}
