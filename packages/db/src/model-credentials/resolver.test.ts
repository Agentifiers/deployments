import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { OrganizationModelKeyUnavailableError } from "@deployments-ai/model-gateway";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "../dynamo-database.ts";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import { makeKmsEnvelopeAdapter } from "../identity/kms-envelope.ts";
import { makeIdGenerator, Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { OrganizationRecord } from "../records/tenancy.ts";
import { makeModelProviderCredentialPersistence } from "./persistence.ts";
import { makeOrganizationModelKeyResolver } from "./resolver.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const ids = makeIdGenerator();
const OWNER_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const KEY_ARN = "arn:aws:kms:us-east-2:123456789012:key/11111111-2222-3333-4444-555555555555";
const FIRST_KEY = "sk-proj-first-secret-key-1111";
const SECOND_KEY = "sk-proj-second-secret-key-2222";

/** Decrypts only under the key and the exact encryption context the data key was generated for. */
function contextBoundKms() {
  const dataKeys = new Map<number, { readonly context: string; readonly keyId: string }>();
  const decrypts: Record<string, string>[] = [];
  let failNext = false;
  const kms = {
    send: async (command: unknown) => {
      if (command instanceof GenerateDataKeyCommand) {
        const id = dataKeys.size + 1;
        dataKeys.set(id, {
          context: JSON.stringify(command.input.EncryptionContext),
          keyId: command.input.KeyId ?? "",
        });
        return { CiphertextBlob: new Uint8Array([id]), Plaintext: new Uint8Array(32).fill(id) };
      }
      if (command instanceof DecryptCommand) {
        decrypts.push({ ...command.input.EncryptionContext });
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
        }
        const id = command.input.CiphertextBlob?.[0] ?? 0;
        const dataKey = dataKeys.get(id);
        if (
          !dataKey ||
          dataKey.keyId !== command.input.KeyId ||
          dataKey.context !== JSON.stringify(command.input.EncryptionContext)
        ) {
          throw Object.assign(new Error("Invalid ciphertext"), {
            name: "InvalidCiphertextException",
          });
        }
        return { Plaintext: new Uint8Array(32).fill(id) };
      }
      throw new Error("Unexpected KMS command.");
    },
  } as unknown as KMSClient;
  return {
    decrypts,
    failNextDecrypt: () => {
      failNext = true;
    },
    kms,
  };
}

function organizationRecord(organizationId: Ulid) {
  return Schema.decodeUnknownSync(OrganizationRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-01-01T00:00:00.000Z",
        id: organizationId,
        name: "Acme",
        slug: `acme-${organizationId.toLowerCase()}`,
        status: "active",
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
}

function harness(database: DynamoDatabaseService, organizationId: Ulid) {
  const credentialId = ids.generate();
  const kms = contextBoundKms();
  const envelope = makeKmsEnvelopeAdapter({ keyId: KEY_ARN, kms: kms.kms, stage: "test" });
  let clock = Date.parse("2026-10-01T00:00:00.000Z");
  const credentials = makeModelProviderCredentialPersistence({
    database,
    envelope,
    generateId: () => credentialId,
  });
  const resolver = makeOrganizationModelKeyResolver({ database, envelope, now: () => clock });
  const change = { actorPrincipalId: OWNER_ID, organizationId, provider: "openai" } as const;
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    credentialId,
    kms,
    remove: () => credentials.remove(change),
    resolve: (keyVersion: number, otherCredentialId?: string) =>
      resolver.resolve({
        credentialId: otherCredentialId ?? credentialId,
        keyVersion,
        organizationId,
        provider: "openai",
      }),
    set: (apiKey: string) => credentials.set({ ...change, apiKey }),
  };
}

function memoryHarness() {
  const organizationId = ids.generate();
  const memory = evaluationMemoryDatabase([organizationRecord(organizationId)]);
  return { ...harness(memory.database, organizationId), database: memory.database, organizationId };
}

describe("organization model key resolver", () => {
  test("decrypts the named key version with the dedicated key and its exact context", async () => {
    const { credentialId, kms, organizationId, resolve, set } = memoryHarness();
    await set(FIRST_KEY);

    expect(await resolve(1)).toBe(FIRST_KEY);
    expect(kms.decrypts).toEqual([
      {
        credentialId,
        keyVersion: "1",
        organizationId,
        provider: "openai",
        purpose: "model-provider-credential",
        stage: "test",
      },
    ]);
  });

  test("reuses a decrypted key for 60 seconds, then reads it again", async () => {
    const { advance, kms, resolve, set } = memoryHarness();
    await set(FIRST_KEY);

    expect([await resolve(1), await resolve(1)]).toEqual([FIRST_KEY, FIRST_KEY]);
    expect(kms.decrypts).toHaveLength(1);
    advance(59_999);
    expect(await resolve(1)).toBe(FIRST_KEY);
    expect(kms.decrypts).toHaveLength(1);
    advance(1);
    expect(await resolve(1)).toBe(FIRST_KEY);
    expect(kms.decrypts).toHaveLength(2);
  });

  test("stops serving a replaced key within the cache window and serves the new version", async () => {
    const { advance, resolve, set } = memoryHarness();
    await set(FIRST_KEY);
    expect(await resolve(1)).toBe(FIRST_KEY);

    await set(SECOND_KEY);
    expect(await resolve(1)).toBe(FIRST_KEY);
    advance(60_000);
    expect(await resolve(1)).toBeUndefined();
    expect(await resolve(2)).toBe(SECOND_KEY);
  });

  test("resolves nothing for a missing credential", async () => {
    expect(await memoryHarness().resolve(1)).toBeUndefined();
  });

  test("resolves nothing for another credential id or a revoked credential", async () => {
    const { remove, resolve, set } = memoryHarness();
    await set(FIRST_KEY);

    expect(await resolve(1, ids.generate())).toBeUndefined();
    await remove();
    expect(await resolve(1)).toBeUndefined();
  });

  test("reports a failed decrypt as unavailable and does not cache the failure", async () => {
    const { kms, resolve, set } = memoryHarness();
    await set(FIRST_KEY);
    kms.failNextDecrypt();

    expect(await resolve(1).catch((error: unknown) => error)).toBeInstanceOf(
      OrganizationModelKeyUnavailableError,
    );
    expect(await resolve(1)).toBe(FIRST_KEY);
  });

  test("cannot open a key sealed for another stage", async () => {
    const { credentialId, database, kms, organizationId, set } = memoryHarness();
    await set(FIRST_KEY);
    const otherStage = makeOrganizationModelKeyResolver({
      database,
      envelope: makeKmsEnvelopeAdapter({ keyId: KEY_ARN, kms: kms.kms, stage: "prod" }),
    });

    expect(
      await otherStage
        .resolve({ credentialId, keyVersion: 1, organizationId, provider: "openai" })
        .catch((error: unknown) => error),
    ).toBeInstanceOf(OrganizationModelKeyUnavailableError);
  });
});

const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;

describe.skipIf(!endpoint)("organization model key resolver on local DynamoDB", () => {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      ...(endpoint ? { endpoint } : {}),
      region: process.env.AWS_REGION ?? "us-east-1",
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const tableNames = tableNamesFromEnvironment();
  const database = makeDynamoDatabase(client, tableNames);

  test("serves the stored key version and stops after it is replaced", async () => {
    const organizationId = ids.generate();
    await client.send(
      new PutCommand({ Item: organizationRecord(organizationId), TableName: tableNames.control }),
    );
    const { advance, resolve, set } = harness(database, organizationId);
    await set(FIRST_KEY);
    expect(await resolve(1)).toBe(FIRST_KEY);

    await set(SECOND_KEY);
    advance(60_000);
    expect([await resolve(1), await resolve(2)]).toEqual([undefined, SECOND_KEY]);
  });
});
