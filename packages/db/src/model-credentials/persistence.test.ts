import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import { makeKmsEnvelopeAdapter } from "../identity/kms-envelope.ts";
import { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import type { ModelProviderCredentialRecord } from "../records/model-credentials.ts";
import { OrganizationRecord } from "../records/tenancy.ts";
import {
  makeModelProviderCredentialPersistence,
  modelProviderCredentialBinding,
} from "./persistence.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const ORG_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const OWNER_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const ADMIN_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const CREDENTIAL_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G5FB0");
const FIRST_KEY = "sk-proj-first-secret-key-1111";
const SECOND_KEY = "sk-proj-second-secret-key-2222";

function fakeKms() {
  const contexts: Record<string, string>[] = [];
  const keyIds: string[] = [];
  let generated = 0;
  const kms = {
    send: async (command: unknown) => {
      if (command instanceof GenerateDataKeyCommand) {
        contexts.push({ ...command.input.EncryptionContext });
        keyIds.push(command.input.KeyId ?? "");
        generated += 1;
        return {
          CiphertextBlob: new Uint8Array([generated]),
          Plaintext: new Uint8Array(32).fill(generated),
        };
      }
      if (command instanceof DecryptCommand) {
        return { Plaintext: new Uint8Array(32).fill(command.input.CiphertextBlob?.[0] ?? 0) };
      }
      throw new Error("Unexpected KMS command.");
    },
  } as unknown as KMSClient;
  return { contexts, keyIds, kms };
}

function harness() {
  const memory = evaluationMemoryDatabase([
    Schema.decodeUnknownSync(OrganizationRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-01-01T00:00:00.000Z",
          id: ORG_ID,
          name: "Acme",
          slug: "acme",
          status: "active",
          updatedAt: "2026-01-01T00:00:00.000Z",
          version: 1,
        },
        itemType: "organization" as const,
      }),
    ),
  ]);
  const kms = fakeKms();
  const envelope = makeKmsEnvelopeAdapter({
    keyId: "model-credential-key",
    kms: kms.kms,
    stage: "test",
  });
  let nextId = 0;
  const generated = [
    CREDENTIAL_ID,
    ...[1, 2, 3, 4, 5].map((index) => ulid(`01ARZ3NDEKTSV4RRFFQ69G5FC${index}`)),
  ];
  let clock = Date.parse("2026-10-01T00:00:00.000Z");
  const credentials = makeModelProviderCredentialPersistence({
    database: memory.database,
    envelope,
    generateId: () => generated[nextId++]!,
    now: () => new Date((clock += 60_000)),
  });
  const stored = () =>
    memory
      .all()
      .find(
        (record): record is ModelProviderCredentialRecord =>
          record.itemType === "model-provider-credential",
      );
  const events = () =>
    memory
      .all()
      .flatMap((record) =>
        record.itemType === "semantic-event"
          ? [[record.data.eventType, record.data.aggregateVersion, record.data.payload] as const]
          : [],
      );
  return { credentials, envelope, events, kms, memory, stored };
}

describe("model provider credential persistence", () => {
  test("seals the key under the organization, provider, credential, and key version only", async () => {
    const { credentials, envelope, kms, stored } = harness();

    const summary = await credentials.set({
      actorPrincipalId: OWNER_ID,
      apiKey: FIRST_KEY,
      label: "Production OpenAI",
      organizationId: ORG_ID,
      provider: "openai",
    });

    expect(kms.keyIds).toEqual(["model-credential-key"]);
    expect(kms.contexts).toEqual([
      {
        credentialId: CREDENTIAL_ID,
        keyVersion: "1",
        organizationId: ORG_ID,
        provider: "openai",
        purpose: "model-provider-credential",
        stage: "test",
      },
    ]);
    const record = stored()!;
    expect([record.pk, record.sk]).toEqual([`ORG#${ORG_ID}`, "MODEL-PROVIDER-CREDENTIAL#openai"]);
    expect(record.data.state.kind).toBe("active");
    if (record.data.state.kind !== "active") throw new Error("expected an active credential");
    expect(
      await envelope.decrypt<string>(
        record.data.state.envelope,
        modelProviderCredentialBinding(record.data),
      ),
    ).toBe(FIRST_KEY);
    expect(summary).toEqual({
      createdAt: "2026-10-01T00:01:00.000Z",
      credentialId: CREDENTIAL_ID,
      keyVersion: 1,
      label: "Production OpenAI",
      lastFour: "1111",
      provider: "openai",
      setAt: "2026-10-01T00:01:00.000Z",
      setBy: OWNER_ID,
      status: "active",
      updatedAt: "2026-10-01T00:01:00.000Z",
      version: 1,
    });
  });

  test("replacing a key bumps its version and changes the ciphertext", async () => {
    const { credentials, stored } = harness();
    const change = {
      actorPrincipalId: OWNER_ID,
      organizationId: ORG_ID,
      provider: "openai" as const,
    };

    await credentials.set({ ...change, apiKey: FIRST_KEY });
    const first = stored()!.data.state;
    const replaced = await credentials.set({
      ...change,
      actorPrincipalId: ADMIN_ID,
      apiKey: SECOND_KEY,
    });
    const second = stored()!.data.state;

    expect(replaced).toMatchObject({
      credentialId: CREDENTIAL_ID,
      keyVersion: 2,
      lastFour: "2222",
      setBy: ADMIN_ID,
      status: "active",
      version: 2,
    });
    if (first.kind !== "active" || second.kind !== "active") throw new Error("expected keys");
    expect(second.envelope.ciphertext).not.toBe(first.envelope.ciphertext);
    expect(second.envelope.encryptedDataKey).not.toBe(first.envelope.encryptedDataKey);
  });

  test("removal clears the ciphertext and keeps the audit trail", async () => {
    const { credentials, events, stored } = harness();
    const change = {
      actorPrincipalId: OWNER_ID,
      organizationId: ORG_ID,
      provider: "openrouter" as const,
    };

    await credentials.set({ ...change, apiKey: FIRST_KEY });
    const removed = await credentials.remove({ ...change, actorPrincipalId: ADMIN_ID });
    const again = await credentials.remove(change);

    expect(stored()!.data.state).toEqual({
      kind: "revoked",
      revokedAt: "2026-10-01T00:02:00.000Z",
      revokedBy: ADMIN_ID,
    });
    expect(removed).toEqual(again);
    expect(removed).toMatchObject({
      credentialId: CREDENTIAL_ID,
      keyVersion: 1,
      lastFour: "1111",
      revokedAt: "2026-10-01T00:02:00.000Z",
      revokedBy: ADMIN_ID,
      status: "revoked",
      version: 2,
    });
    expect(events()).toEqual([
      [
        "organization.model-credential-set",
        1,
        { credentialId: CREDENTIAL_ID, keyVersion: 1, provider: "openrouter" },
      ],
      [
        "organization.model-credential-removed",
        2,
        { credentialId: CREDENTIAL_ID, keyVersion: 1, provider: "openrouter" },
      ],
    ]);
  });

  test("setting a key after removal reactivates the credential at the next key version", async () => {
    const { credentials, events } = harness();
    const change = {
      actorPrincipalId: OWNER_ID,
      organizationId: ORG_ID,
      provider: "openai" as const,
    };

    await credentials.set({ ...change, apiKey: FIRST_KEY });
    await credentials.remove(change);
    const restored = await credentials.set({ ...change, apiKey: SECOND_KEY });

    expect(restored).toMatchObject({
      credentialId: CREDENTIAL_ID,
      keyVersion: 2,
      status: "active",
    });
    expect(restored).not.toHaveProperty("revokedAt");
    expect(events().map(([type, version]) => [type, version])).toEqual([
      ["organization.model-credential-set", 1],
      ["organization.model-credential-removed", 2],
      ["organization.model-credential-set", 3],
    ]);
  });

  test("replaces and removes a key whose semantic events retention deleted", async () => {
    const { credentials, events, memory } = harness();
    const change = {
      actorPrincipalId: OWNER_ID,
      organizationId: ORG_ID,
      provider: "openai" as const,
    };
    await credentials.set({ ...change, apiKey: FIRST_KEY });
    for (const [itemKey, record] of memory.records) {
      if (record.itemType === "semantic-event") memory.records.delete(itemKey);
    }

    const replaced = await credentials.set({ ...change, apiKey: SECOND_KEY });
    await credentials.remove(change);

    expect({ keyVersion: replaced.keyVersion, version: replaced.version }).toEqual({
      keyVersion: 2,
      version: 2,
    });
    expect(events().map(([type, version]) => [type, version])).toEqual([
      ["organization.model-credential-set", 2],
      ["organization.model-credential-removed", 3],
    ]);
  });

  test("no read returns the key or its ciphertext", async () => {
    const { credentials, events } = harness();
    const change = { actorPrincipalId: OWNER_ID, organizationId: ORG_ID };

    await credentials.set({ ...change, apiKey: FIRST_KEY, provider: "openai" });
    await credentials.set({ ...change, apiKey: SECOND_KEY, provider: "openrouter" });
    const reads = JSON.stringify([
      await credentials.list(ORG_ID),
      await credentials.get(ORG_ID, "openai"),
      events(),
    ]);

    expect((await credentials.list(ORG_ID)).map((summary) => summary.provider)).toEqual([
      "openai",
      "openrouter",
    ]);
    for (const secret of [FIRST_KEY, SECOND_KEY, "ciphertext", "encryptedDataKey", "envelope"]) {
      expect(reads).not.toContain(secret);
    }
  });

  test("returns nothing for a provider the organization never configured", async () => {
    const { credentials } = harness();

    expect(await credentials.get(ORG_ID, "openai")).toBeUndefined();
    expect(await credentials.list(ORG_ID)).toEqual([]);
    expect(
      await credentials.remove({
        actorPrincipalId: OWNER_ID,
        organizationId: ORG_ID,
        provider: "openai",
      }),
    ).toBeUndefined();
  });
});
