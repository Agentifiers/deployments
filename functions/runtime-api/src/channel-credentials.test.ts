import { describe, expect, test } from "bun:test";
import type { KMSClient } from "@aws-sdk/client-kms";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ApiCredentialRecord,
  ChannelBindingRecord,
  ServiceAccountRecord,
  makeCredentialVault,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type CredentialVaultReference,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { archiveChannelBinding, verifyChannelBinding } from "./channel-bindings.ts";
import { createRuntimeApiHandler } from "./runtime-handler.ts";
import { deployment, ids, memoryDatabase, now, principal } from "./runtime-lifecycle.fixture.ts";
import { credentialHash, type RuntimeApiDependencies } from "./runtime-support.ts";

function fixture() {
  const caller = principal();
  const token = "dpl_test_binding_credential_only";
  const common = {
    ...caller.scope,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: 0,
  };
  const account = Schema.decodeUnknownSync(ServiceAccountRecord)(
    withCanonicalRecordKeys({
      itemType: "service-account" as const,
      data: {
        ...common,
        id: ids[3]!,
        name: "Channel service",
        scopes: ["channels:write"],
        status: "active" as const,
      },
    }),
  );
  const credential = Schema.decodeUnknownSync(ApiCredentialRecord)(
    withCanonicalRecordKeys({
      itemType: "api-credential" as const,
      data: {
        ...common,
        id: ids[31]!,
        credentialHash: credentialHash(token),
        keyPrefix: "dpl_test",
        name: "Channel credential",
        scopes: ["channels:write"],
        serviceAccountId: account.data.id,
        status: "active" as const,
      },
    }),
  );
  const claim = makeUniqueClaimRecord(
    uniqueClaimRequirements(credential)[0]!,
    now.toISOString(),
  ) as PlatformRecord;
  const binding = Schema.decodeUnknownSync(ChannelBindingRecord)(
    withCanonicalRecordKeys({
      itemType: "channel-binding" as const,
      data: {
        ...common,
        id: ids[9]!,
        agentDefinitionId: ids[5]!,
        agentDeploymentId: ids[4]!,
        channel: "telegram",
        provider: "telegram",
        externalWorkspaceId: "bot-1",
        externalChannelId: "bot-1",
        status: "disabled" as const,
      },
    }),
  );
  const memory = memoryDatabase([account, credential, claim, binding, deployment()]);
  const recordKey = (record: Pick<PlatformRecord, "pk" | "sk">) => `${record.pk}\n${record.sk}`;
  const put = (record: PlatformRecord) => memory.records.set(recordKey(record), record);
  let beforeCommit: (() => void) | undefined;
  let failCommit = false;
  const database = {
    ...memory.database,
    transactWrite: (async (operations) => {
      beforeCommit?.();
      beforeCommit = undefined;
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const current = memory.records.get(recordKey(operation.record));
        const previous = operation.kind === "put" ? operation.previousRecord : operation.record;
        const actualVersion =
          current && "version" in current.data ? current.data.version : undefined;
        const expectedVersion =
          previous && "version" in previous.data ? previous.data.version : undefined;
        if (
          failCommit ||
          (previous ? !current || actualVersion !== expectedVersion : current !== undefined)
        ) {
          const conflict = new Error("simulated conditional conflict");
          conflict.name = "ConditionalCheckFailedException";
          throw conflict;
        }
      }
      // Validate every condition before applying anything, like a DynamoDB transaction.
      return memory.database.transactWrite(operations);
    }) as typeof memory.database.transactWrite,
  };
  const vault = makeCredentialVault({
    documentClient: {
      async send(command: unknown) {
        if (!(command instanceof GetCommand)) throw new Error("Only vault reads are expected");
        const key = command.input.Key!;
        return { Item: memory.records.get(`${key.pk}\n${key.sk}`) };
      },
    } as unknown as DynamoDBDocumentClient,
    kmsClient: {
      async send(command: object) {
        const key = Buffer.alloc(32, 7);
        return command.constructor.name === "GenerateDataKeyCommand"
          ? { CiphertextBlob: Buffer.from("wrapped-key"), Plaintext: key }
          : { Plaintext: key };
      },
    } as unknown as KMSClient,
    kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
    tableName: "control",
  });
  let generated = 10;
  const dependencies = {
    database,
    credentialVault: vault,
    generateId: async () => ids[generated++]!,
    now: () => now,
  } as unknown as RuntimeApiDependencies;
  const handler = createRuntimeApiHandler(dependencies);
  const request = async (
    method: "PUT" | "DELETE",
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => {
    const result = await handler({
      rawPath: `/v1/channel-bindings/${binding.data.id}/credential`,
      requestContext: { http: { method } },
      headers: { authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });
    return { status: result.statusCode, body: JSON.parse(result.body!) };
  };
  const currentBinding = () => memory.records.get(recordKey(binding)) as typeof binding;
  const reference = () => currentBinding().data.credentialRef as CredentialVaultReference;
  const readSecret = (ref: CredentialVaultReference) =>
    vault.read({
      organizationId: caller.scope.organizationId,
      environmentId: caller.scope.environmentId,
      reference: ref,
      expectedIdentity: {
        ownerId: binding.data.id,
        ownerType: "channel-binding",
        projectId: caller.scope.projectId,
        purpose: "channel-runtime",
      },
    });
  return {
    account,
    binding,
    caller,
    credential,
    currentBinding,
    dependencies,
    memory,
    put,
    readSecret,
    reference,
    request,
    vault,
    failCommit: () => {
      failCommit = true;
    },
    race: (change: () => void) => {
      beforeCommit = change;
    },
  };
}

const attach = (expectedVersion: number, token = "first-secret") => ({
  expectedVersion,
  values: { botToken: token },
});

describe("runtime binding-owned credentials", () => {
  test("uses only a scoped opaque key, redacts material, and requires verification after every rotation", async () => {
    const f = fixture();
    const attached = await f.request("PUT", attach(0));
    expect(attached).toMatchObject({
      status: 200,
      body: { version: 1, status: "disabled", credentialAttached: true },
    });
    expect(attached.body).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(attached.body)).not.toContain("first-secret");
    const firstReference = f.reference();
    expect((await f.readSecret(firstReference)).values.botToken).toBe("first-secret");
    await verifyChannelBinding(f.caller, f.binding.data.id, f.dependencies);
    expect(f.currentBinding().data.status).toBe("active");
    const rotated = await f.request("PUT", attach(2, "second-secret"));
    expect(rotated).toMatchObject({
      status: 200,
      body: { version: 3, status: "disabled", credentialAttached: true },
    });
    expect(rotated.body).not.toHaveProperty("lastVerifiedAt");
    expect(f.readSecret(firstReference)).rejects.toMatchObject({ code: "conflict" });
    expect((await f.readSecret(f.reference())).values.botToken).toBe("second-secret");
  });

  test("revokes old reads, clears ownership, and requires a new credential on reattachment", async () => {
    const f = fixture();
    await f.request("PUT", attach(0));
    const oldReference = f.reference();
    expect(await f.request("DELETE", { expectedVersion: 1 })).toMatchObject({
      status: 200,
      body: { version: 2, status: "disabled", credentialAttached: false },
    });
    expect(f.readSecret(oldReference)).rejects.toMatchObject({ code: "revoked" });
    expect(await f.request("DELETE", { expectedVersion: 1 })).toMatchObject({ status: 409 });
    expect(await f.request("DELETE", { expectedVersion: 2 })).toMatchObject({
      status: 200,
      body: { version: 2 },
    });
    await f.request("PUT", attach(2, "fresh-secret"));
    expect(f.reference().credentialId).not.toBe(oldReference.credentialId);
    expect(f.readSecret(oldReference)).rejects.toMatchObject({ code: "revoked" });
  });

  test("permits revocation after archival without reactivating or unarchiving the binding", async () => {
    const f = fixture();
    await f.request("PUT", attach(0));
    const oldReference = f.reference();
    await archiveChannelBinding(f.caller, f.binding.data.id, f.dependencies);
    expect(await f.request("PUT", attach(2))).toMatchObject({ status: 409 });
    expect(await f.request("DELETE", { expectedVersion: 2 })).toMatchObject({
      status: 200,
      body: { status: "archived", credentialAttached: false },
    });
    expect(f.readSecret(oldReference)).rejects.toMatchObject({ code: "revoked" });
  });

  test("rejects tenant header widening, foreign binding ownership, and either missing scope", async () => {
    const f = fixture();
    for (const dimension of ["organization", "project", "environment"]) {
      expect(
        await f.request("PUT", attach(0), { [`x-deployments-${dimension}`]: ids[30]! }),
      ).toMatchObject({ status: 403 });
    }
    f.put({ ...f.binding, data: { ...f.binding.data, projectId: ids[30]! } });
    expect(await f.request("PUT", attach(0))).toMatchObject({ status: 404 });
    f.put(f.binding);
    f.put({ ...f.credential, data: { ...f.credential.data, scopes: ["channels:read"] } });
    expect(await f.request("PUT", attach(0))).toMatchObject({ status: 403 });
    f.put(f.credential);
    f.put({ ...f.account, data: { ...f.account.data, scopes: ["channels:read"] } });
    expect(await f.request("DELETE", { expectedVersion: 0 })).toMatchObject({ status: 403 });
    expect(f.memory.transactions).toHaveLength(0);
  });

  test("strictly rejects malformed versions, fields, scopes, expiration and reserved OAuth material without echoing secrets", async () => {
    const f = fixture();
    const invalid = [
      { ...attach(0), expectedVersion: -1 },
      { ...attach(0), expectedVersion: "0" },
      { values: { botToken: "sensitive-value" } },
      { expectedVersion: 0, values: { botToken: 123 } },
      { expectedVersion: 0, values: {} },
      { expectedVersion: 0, values: { "deploymentsAi.providerRequestHeaders": "sensitive-value" } },
      { ...attach(0), scopes: [123] },
      { ...attach(0), scopes: [" "] },
      { ...attach(0), expiresAt: "invalid-date" },
      { ...attach(0), expiresAt: now.toISOString() },
      { ...attach(0), ownerId: ids[30]! },
    ];
    for (const body of invalid) {
      const result = await f.request("PUT", body);
      expect(result.status).toBe(400);
      expect(JSON.stringify(result.body)).not.toContain("sensitive-value");
    }
    expect(await f.request("PUT", attach(1))).toMatchObject({ status: 409 });
    expect(f.memory.transactions).toHaveLength(0);
  });

  test("rolls back vault rotation, binding state, audit and semantic events together on transaction failure", async () => {
    const f = fixture();
    await f.request("PUT", attach(0));
    const oldReference = f.reference();
    const before = [...f.memory.records.entries()];
    f.failCommit();
    expect(await f.request("PUT", attach(1, "uncommitted-secret"))).toMatchObject({ status: 409 });
    expect([...f.memory.records.entries()]).toEqual(before);
    expect((await f.readSecret(oldReference)).values.botToken).toBe("first-secret");
    expect(await f.request("DELETE", { expectedVersion: 1 })).toMatchObject({ status: 409 });
    expect([...f.memory.records.entries()]).toEqual(before);
    expect((await f.readSecret(oldReference)).values.botToken).toBe("first-secret");
  });

  test("fences a binding changed after vault preparation and rejects a stale pinned generation", async () => {
    const f = fixture();
    await f.request("PUT", attach(0));
    const oldReference = f.reference();
    const current = f.currentBinding();
    f.race(() => f.put({ ...current, data: { ...current.data, version: 2, status: "archived" } }));
    expect(await f.request("PUT", attach(1, "losing-secret"))).toMatchObject({ status: 409 });
    expect((await f.readSecret(oldReference)).values.botToken).toBe("first-secret");
    f.put(current);
    const rotated = await f.vault.prepareWrite({
      identity: {
        ...f.caller.scope,
        credentialId: oldReference.credentialId,
        ownerId: f.binding.data.id,
        ownerType: "channel-binding",
        purpose: "channel-runtime",
      },
      expectedGeneration: oldReference.generation,
      secret: { values: { botToken: "concurrent-secret" } },
    });
    f.race(() => f.put(rotated.operation.record));
    expect(await f.request("PUT", attach(1))).toMatchObject({ status: 409 });
    expect(f.currentBinding()).toEqual(current);
    expect(await f.request("DELETE", { expectedVersion: 1 })).toMatchObject({ status: 409 });
    expect((await f.readSecret(rotated.reference)).values.botToken).toBe("concurrent-secret");
  });

  test("refuses to revoke a credential owned by another binding even with a matching tenant and generation", async () => {
    const f = fixture();
    const prepared = await f.vault.prepareWrite({
      identity: {
        ...f.caller.scope,
        credentialId: ids[20]!,
        ownerId: ids[21]!,
        ownerType: "channel-binding",
        purpose: "channel-runtime",
      },
      secret: { values: { botToken: "other-owner-secret" } },
    });
    f.put(prepared.operation.record);
    f.put({ ...f.binding, data: { ...f.binding.data, credentialRef: prepared.reference } });
    expect(await f.request("DELETE", { expectedVersion: 0 })).toMatchObject({ status: 409 });
    expect(await f.request("PUT", attach(0))).toMatchObject({ status: 409 });
    expect(
      f.memory.records.get(`${prepared.operation.record.pk}\n${prepared.operation.record.sk}`),
    ).toEqual(prepared.operation.record);
  });
});
