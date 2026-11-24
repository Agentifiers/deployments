import { describe, expect, test } from "bun:test";
import type { KMSClient } from "@aws-sdk/client-kms";
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { CredentialVaultEntryRecord, withCanonicalRecordKeys, type Ulid } from "../index.ts";
import { Schema } from "effect";

import {
  CredentialDataKeyCache,
  CredentialVaultError,
  decryptCredentialDocument,
  encryptCredentialDocument,
  makeCredentialVault,
  normalizeCredentialVaultSecret,
} from "./index.ts";

function fakeKms() {
  const key = Buffer.alloc(32, 7);
  let decryptCount = 0;
  return {
    client: {
      async send(command: object) {
        if (command.constructor.name === "GenerateDataKeyCommand") {
          return { CiphertextBlob: Buffer.from("wrapped-key"), Plaintext: Buffer.from(key) };
        }
        decryptCount += 1;
        return { Plaintext: Buffer.from(key) };
      },
    } as unknown as KMSClient,
    decryptCount: () => decryptCount,
  };
}

describe("credential vault envelope encryption", () => {
  test("encrypts credentials with KMS-wrapped data keys and caches decrypts", async () => {
    const kms = fakeKms();
    const context = {
      credentialId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      organizationId: "org",
      projectId: "project",
    };
    const encrypted = await encryptCredentialDocument({
      context,
      kmsClient: kms.client,
      kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/example",
      plaintext: JSON.stringify({ token: "secret" }),
    });
    expect(encrypted.ciphertext).not.toContain("secret");

    const cache = new CredentialDataKeyCache(60_000, 10);
    const first = await decryptCredentialDocument({
      ...encrypted,
      cache,
      context,
      kmsClient: kms.client,
      kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/example",
    });
    const second = await decryptCredentialDocument({
      ...encrypted,
      cache,
      context,
      kmsClient: kms.client,
      kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/example",
    });
    expect(first).toBe('{"token":"secret"}');
    expect(second).toBe(first);
    expect(kms.decryptCount()).toBe(1);
  });

  test("binds ciphertext to its tenant and owner encryption context", async () => {
    const kms = fakeKms();
    const encrypted = await encryptCredentialDocument({
      context: { credentialId: "credential", organizationId: "org-a" },
      kmsClient: kms.client,
      kmsKeyArn: "key",
      plaintext: "secret",
    });
    expect(
      decryptCredentialDocument({
        ...encrypted,
        cache: new CredentialDataKeyCache(),
        context: { credentialId: "credential", organizationId: "org-b" },
        kmsClient: kms.client,
        kmsKeyArn: "key",
      }),
    ).rejects.toMatchObject({ code: "crypto" });
  });

  test("rejects empty and malformed credential fields", () => {
    expect(() => normalizeCredentialVaultSecret({ values: {} })).toThrow(CredentialVaultError);
    expect(() => normalizeCredentialVaultSecret({ values: { "bad field": "secret" } })).toThrow(
      "Invalid credential field name",
    );
  });

  test("sets DynamoDB TTL and rejects reads for expired credentials", async () => {
    const ids = {
      credential: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid,
      environment: "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid,
      organization: "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid,
      owner: "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid,
      project: "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid,
    };
    const expiresAt = "2026-07-23T00:10:00.000Z";
    const vault = makeCredentialVault({
      documentClient: {
        send: async () => ({}),
      } as unknown as DynamoDBDocumentClient,
      kmsClient: fakeKms().client,
      kmsKeyArn: "key",
      tableName: "control",
    });
    const prepared = await vault.prepareWrite({
      identity: {
        credentialId: ids.credential,
        environmentId: ids.environment,
        organizationId: ids.organization,
        ownerId: ids.owner,
        ownerType: "oauth-authorization-attempt",
        projectId: ids.project,
        purpose: "oauth-pkce-verifier",
      },
      secret: { expiresAt, values: { verifier: "secret" } },
    });
    expect(prepared.operation.record.ttl).toBe(Math.floor(Date.parse(expiresAt) / 1_000));
    expect(() =>
      Schema.decodeUnknownSync(CredentialVaultEntryRecord)({
        ...prepared.operation.record,
        ttl: undefined,
      }),
    ).not.toThrow();

    const expiredVault = makeCredentialVault({
      documentClient: {
        send: async () => ({ Item: prepared.operation.record }),
      } as unknown as DynamoDBDocumentClient,
      kmsClient: fakeKms().client,
      kmsKeyArn: "key",
      tableName: "control",
    });
    expect(
      expiredVault.read({
        environmentId: ids.environment,
        expectedIdentity: {
          ownerId: ids.owner,
          ownerType: "oauth-authorization-attempt",
          projectId: ids.project,
          purpose: "oauth-pkce-verifier",
        },
        organizationId: ids.organization,
        reference: prepared.reference,
      }),
    ).rejects.toMatchObject({ code: "revoked", message: "Credential has expired." });
  });

  test("rejects credential reads outside the expected project, owner, or purpose", async () => {
    const ids = {
      credential: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid,
      environment: "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid,
      organization: "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid,
      owner: "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid,
      project: "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid,
    };
    const entry = Schema.decodeUnknownSync(CredentialVaultEntryRecord)(
      withCanonicalRecordKeys({
        data: {
          algorithm: "AES-256-GCM" as const,
          authTag: "tag",
          ciphertext: "ciphertext",
          createdAt: "2026-07-23T00:00:00.000Z",
          encryptedDataKey: "encrypted-key",
          encryptionContextHash: "hash",
          environmentId: ids.environment,
          generation: 1,
          id: ids.credential,
          iv: "iv",
          kmsKeyArn: "key",
          organizationId: ids.organization,
          ownerId: ids.owner,
          ownerType: "provider-connection" as const,
          projectId: ids.project,
          purpose: "provider-oauth-token",
          status: "active" as const,
          updatedAt: "2026-07-23T00:00:00.000Z",
          version: 1,
        },
        itemType: "credential-vault-entry" as const,
      }),
    );
    for (const data of [
      entry.data,
      { ...entry.data, status: "revoked" as const },
      { ...entry.data, generation: 2, version: 2 },
    ]) {
      const stored = Schema.decodeUnknownSync(CredentialVaultEntryRecord)(
        withCanonicalRecordKeys({ data, itemType: "credential-vault-entry" as const }),
      );
      const vault = makeCredentialVault({
        documentClient: {
          send: async () => ({ Item: stored }),
        } as unknown as DynamoDBDocumentClient,
        kmsClient: fakeKms().client,
        kmsKeyArn: "key",
        tableName: "control",
      });

      expect(
        vault.read({
          environmentId: ids.environment,
          expectedIdentity: {
            ownerId: ids.owner,
            ownerType: "provider-connection",
            projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid,
            purpose: "provider-oauth-token",
          },
          organizationId: ids.organization,
          reference: { credentialId: ids.credential, generation: 1, store: "dynamodb-kms" },
        }),
      ).rejects.toMatchObject({ code: "not-found" });
    }
  });

  test("fences direct credential writes and revocations against erasure and missing tenants", async () => {
    const ids = {
      credential: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid,
      environment: "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid,
      organization: "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid,
      owner: "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid,
      project: "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid,
    };
    const commands: unknown[] = [];
    let stored: Record<string, unknown> | undefined;
    const vault = makeCredentialVault({
      documentClient: {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof GetCommand) return { Item: stored };
          if (command instanceof TransactWriteCommand) {
            stored = command.input.TransactItems?.[2]?.Put?.Item;
          }
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      kmsClient: fakeKms().client,
      kmsKeyArn: "key",
      tableName: "control",
    });
    const identity = {
      credentialId: ids.credential,
      environmentId: ids.environment,
      organizationId: ids.organization,
      ownerId: ids.owner,
      ownerType: "provider-connection" as const,
      projectId: ids.project,
      purpose: "provider-oauth-token",
    };

    const reference = await vault.write({ identity, secret: { values: { token: "secret" } } });
    await vault.revoke({
      environmentId: ids.environment,
      organizationId: ids.organization,
      reference,
    });

    const writes = commands.filter(
      (command): command is TransactWriteCommand => command instanceof TransactWriteCommand,
    );
    expect(writes).toHaveLength(2);
    for (const command of writes) {
      expect(command.input.TransactItems?.[0]?.ConditionCheck).toMatchObject({
        ConditionExpression:
          "attribute_not_exists(pk) OR #fenceData.#fenceLeaseExpiresAt <= :fenceObservedAt",
        ExpressionAttributeNames: {
          "#fenceData": "data",
          "#fenceLeaseExpiresAt": "leaseExpiresAt",
        },
        Key: {
          pk: `ORG#${ids.organization}`,
          sk: `ERASURE-FENCE#${ids.organization}`,
        },
      });
      expect(
        Date.parse(
          String(
            command.input.TransactItems?.[0]?.ConditionCheck?.ExpressionAttributeValues?.[
              ":fenceObservedAt"
            ],
          ),
        ),
      ).toBeNumber();
      expect(command.input.TransactItems?.[1]?.ConditionCheck).toMatchObject({
        ConditionExpression: "attribute_exists(pk)",
        Key: {
          pk: `ORG#${ids.organization}`,
          sk: `ORG#${ids.organization}`,
        },
      });
      expect(command.input.TransactItems?.[2]?.Put?.TableName).toBe("control");
    }
  });

  test("preserves credential conflicts from transactional conditional writes", async () => {
    const ids = {
      credential: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid,
      environment: "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid,
      organization: "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid,
      owner: "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid,
      project: "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid,
    };
    const vault = makeCredentialVault({
      documentClient: {
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) {
            throw Object.assign(new Error("transaction canceled"), {
              CancellationReasons: [
                { Code: "None" },
                { Code: "None" },
                { Code: "ConditionalCheckFailed" },
              ],
              name: "TransactionCanceledException",
            });
          }
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      kmsClient: fakeKms().client,
      kmsKeyArn: "key",
      tableName: "control",
    });

    expect(
      vault.write({
        identity: {
          credentialId: ids.credential,
          environmentId: ids.environment,
          organizationId: ids.organization,
          ownerId: ids.owner,
          ownerType: "provider-connection",
          projectId: ids.project,
          purpose: "provider-oauth-token",
        },
        secret: { values: { token: "secret" } },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
