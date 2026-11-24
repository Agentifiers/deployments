import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import {
  decodePlatformRecord,
  makeCredentialReferenceInventory,
  withCanonicalRecordKeys,
  type CredentialReferenceOwnerType,
  type CredentialReferencePosition,
  type CredentialReferenceSummary,
  type PlatformRecord,
  type Ulid,
} from "../index.ts";

const id = (index: number) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}` as Ulid;
const ORGANIZATION_ID = id(1);
const PROJECT_ID = id(2);
const ENVIRONMENT_ID = id(3);
const OTHER_ENVIRONMENT_ID = id(4);
const CREATED_AT = "2026-09-01T00:00:00.000Z";
const UPDATED_AT = "2026-09-15T00:00:00.000Z";
const TOKEN_EXPIRES_AT = "2026-10-01T01:00:00.000Z";
const SECRET_MATERIAL = [
  "CIPHERTEXT-MUST-NOT-LEAK",
  "AUTH-TAG-MUST-NOT-LEAK",
  "DATA-KEY-MUST-NOT-LEAK",
  "CONTEXT-HASH-MUST-NOT-LEAK",
  "IV-MUST-NOT-LEAK",
];

const reference = (credentialId: Ulid, generation: number) => ({
  credentialId,
  generation,
  store: "dynamodb-kms" as const,
});

function record(
  itemType: PlatformRecord["itemType"],
  data: Readonly<Record<string, unknown>>,
): PlatformRecord {
  return Effect.runSync(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: CREATED_AT,
          environmentId: ENVIRONMENT_ID,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          status: "active",
          updatedAt: UPDATED_AT,
          version: 1,
          ...data,
        },
        itemType,
      }),
    ),
  );
}

const owners = {
  channelBinding: (ownerId: Ulid, extra: Readonly<Record<string, unknown>> = {}) =>
    record("channel-binding", {
      agentDefinitionId: id(90),
      channel: "slack",
      id: ownerId,
      provider: "slack",
      ...extra,
    }),
  mcpServer: (ownerId: Ulid, extra: Readonly<Record<string, unknown>> = {}) =>
    record("mcp-server", {
      endpointOrigin: "https://mcp.example.test",
      endpointPath: "/mcp",
      id: ownerId,
      name: `mcp-${ownerId.slice(-2)}`,
      toolAllowlist: [],
      ...extra,
    }),
  providerApplication: (ownerId: Ulid, extra: Readonly<Record<string, unknown>> = {}) =>
    record("provider-application", {
      clientId: "public-client-id",
      displayName: "Customer OAuth app",
      id: ownerId,
      providerKey: "github",
      redirectUris: ["https://app.example.test/oauth/callback"],
      requestedScopes: ["repo"],
      ...extra,
    }),
  providerConnection: (ownerId: Ulid, extra: Readonly<Record<string, unknown>> = {}) =>
    record("provider-connection", {
      authMethod: "static",
      id: ownerId,
      providerKey: "stripe",
      scopes: [],
      ...extra,
    }),
  toolAdapter: (ownerId: Ulid, extra: Readonly<Record<string, unknown>> = {}) =>
    record("tool-adapter", {
      effect: "read",
      execution: {
        endpointOrigin: "https://callbacks.example.test",
        endpointPath: "/tool",
        type: "http_callback",
      },
      id: ownerId,
      name: `tool_${ownerId.slice(-2)}`,
      requiredScopes: [],
      ...extra,
    }),
  webhookEndpoint: (ownerId: Ulid, extra: Readonly<Record<string, unknown>> = {}) =>
    record("webhook-endpoint", {
      eventTypes: ["run.completed"],
      id: ownerId,
      name: `webhook-${ownerId.slice(-2)}`,
      signingSecretRef: reference(id(80), 0),
      url: "https://hooks.example.test/events",
      ...extra,
    }),
};

function vaultEntry(credentialId: Ulid, ownerId: Ulid) {
  return record("credential-vault-entry", {
    algorithm: "AES-256-GCM",
    authTag: SECRET_MATERIAL[1],
    ciphertext: SECRET_MATERIAL[0],
    encryptedDataKey: SECRET_MATERIAL[2],
    encryptionContextHash: SECRET_MATERIAL[3],
    generation: 1,
    id: credentialId,
    iv: SECRET_MATERIAL[4],
    kmsKeyArn: "arn:aws:kms:us-east-1:111122223333:key/vault",
    ownerId,
    ownerType: "provider-application",
    purpose: "provider-oauth-client-secret",
  });
}

const elsewhere = { environmentId: OTHER_ENVIRONMENT_ID };

/** Every owner type with a vault reference, an owner without one, and another environment. */
function environmentRecords() {
  return [
    owners.channelBinding(id(10), { credentialRef: reference(id(50), 2) }),
    owners.channelBinding(id(11)),
    owners.mcpServer(id(12), { authSecretRef: reference(id(51), 0) }),
    owners.mcpServer(id(13)),
    owners.providerApplication(id(14), { clientSecretRef: reference(id(52), 1) }),
    owners.providerConnection(id(15), {
      authMethod: "oauth",
      credentialRef: reference(id(53), 3),
      displayMetadata: { displayName: "Customer GitHub" },
      providerKey: "github",
      refreshAfter: TOKEN_EXPIRES_AT,
    }),
    owners.providerConnection(id(16), { credentialRef: reference(id(54), 0) }),
    owners.toolAdapter(id(17), { authSecretRef: reference(id(55), 1) }),
    owners.toolAdapter(id(18), {
      authSecretRef: reference(id(56), 4),
      effect: "execute",
      execution: {
        contentHash: `sha256:${"a".repeat(64)}`,
        entrypoint: "handler",
        language: "javascript",
        memoryMiB: 256,
        network: "none",
        secretNames: ["API_TOKEN", "SIGNING_KEY"],
        sourceLanguage: "typescript",
        timeoutMs: 5_000,
        type: "hosted_code",
      },
    }),
    owners.webhookEndpoint(id(19), { signingSecretRef: reference(id(57), 0) }),
    vaultEntry(id(52), id(14)),
    owners.channelBinding(id(20), { credentialRef: reference(id(60), 0), ...elsewhere }),
    owners.mcpServer(id(21), { authSecretRef: reference(id(61), 0), ...elsewhere }),
    owners.providerApplication(id(22), { clientSecretRef: reference(id(62), 0), ...elsewhere }),
    owners.providerConnection(id(23), { credentialRef: reference(id(63), 0), ...elsewhere }),
    owners.toolAdapter(id(24), { authSecretRef: reference(id(64), 0), ...elsewhere }),
    owners.webhookEndpoint(id(25), elsewhere),
  ];
}

function inventory(records: readonly PlatformRecord[]) {
  return makeCredentialReferenceInventory(evaluationMemoryDatabase(records).database);
}

function list(
  records: readonly PlatformRecord[],
  input: {
    readonly after?: CredentialReferencePosition;
    readonly limit?: number;
    readonly ownerType?: CredentialReferenceOwnerType;
  } = {},
) {
  return inventory(records).list({
    environmentId: ENVIRONMENT_ID,
    limit: input.limit ?? 100,
    organizationId: ORGANIZATION_ID,
    ...(input.after ? { after: input.after } : {}),
    ...(input.ownerType ? { ownerType: input.ownerType } : {}),
  });
}

async function walk(
  records: readonly PlatformRecord[],
  limit: number,
  ownerType?: CredentialReferenceOwnerType,
) {
  const items: CredentialReferenceSummary[] = [];
  let after: CredentialReferencePosition | undefined;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await list(records, {
      limit,
      ...(after ? { after } : {}),
      ...(ownerType ? { ownerType } : {}),
    });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    if (!page.next) return items;
    after = page.next;
  }
  throw new Error("Inventory pagination did not terminate.");
}

const base = {
  createdAt: CREATED_AT,
  status: "active",
  store: "dynamodb-kms",
  updatedAt: UPDATED_AT,
} as const;

const EXPECTED_ITEMS: readonly CredentialReferenceSummary[] = [
  {
    ...base,
    credentialId: id(50),
    generation: 2,
    ownerId: id(10),
    ownerStatus: "active",
    ownerType: "channel-binding",
    providerKey: "slack",
    purpose: "channel-runtime",
  },
  {
    ...base,
    credentialId: id(51),
    generation: 0,
    ownerId: id(12),
    ownerName: "mcp-12",
    ownerStatus: "active",
    ownerType: "mcp-server",
    purpose: "mcp-server-auth",
  },
  {
    ...base,
    credentialId: id(52),
    generation: 1,
    ownerId: id(14),
    ownerName: "Customer OAuth app",
    ownerStatus: "active",
    ownerType: "provider-application",
    providerKey: "github",
    purpose: "provider-oauth-client-secret",
  },
  {
    ...base,
    credentialId: id(53),
    expiresAt: TOKEN_EXPIRES_AT,
    generation: 3,
    ownerId: id(15),
    ownerName: "Customer GitHub",
    ownerStatus: "active",
    ownerType: "provider-connection",
    providerKey: "github",
    purpose: "provider-oauth-token",
  },
  {
    ...base,
    credentialId: id(54),
    generation: 0,
    ownerId: id(16),
    ownerName: "stripe",
    ownerStatus: "active",
    ownerType: "provider-connection",
    providerKey: "stripe",
    purpose: "provider-api",
  },
  {
    ...base,
    credentialId: id(55),
    generation: 1,
    ownerId: id(17),
    ownerName: "tool_17",
    ownerStatus: "active",
    ownerType: "tool-adapter",
    purpose: "extension-callback-auth",
  },
  {
    ...base,
    credentialId: id(56),
    generation: 4,
    ownerId: id(18),
    ownerName: "tool_18",
    ownerStatus: "active",
    ownerType: "tool-adapter",
    purpose: "hosted-code-secrets",
    secretNames: ["API_TOKEN", "SIGNING_KEY"],
  },
  {
    ...base,
    credentialId: id(57),
    generation: 0,
    ownerId: id(19),
    ownerName: "webhook-19",
    ownerStatus: "active",
    ownerType: "webhook-endpoint",
    purpose: "webhook-signing",
  },
];

describe("credential reference inventory", () => {
  test("lists each environment owner's vault reference with its purpose and generation", async () => {
    const page = await list(environmentRecords());

    expect(page.items).toEqual(EXPECTED_ITEMS);
    expect(page.next).toBeUndefined();
  });

  test("never returns vault secret material", async () => {
    const serialized = JSON.stringify(await walk(environmentRecords(), 3));

    for (const material of SECRET_MATERIAL) expect(serialized).not.toContain(material);
    for (const field of ["ciphertext", "authTag", "encryptedDataKey", "iv", "kmsKeyArn"]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });

  test("derives the reference status from the owner lifecycle", async () => {
    const page = await list([
      owners.channelBinding(id(10), { credentialRef: reference(id(50), 1), status: "archived" }),
      owners.mcpServer(id(12), { authSecretRef: reference(id(51), 0), status: "archived" }),
      owners.providerApplication(id(14), {
        clientSecretRef: reference(id(52), 1),
        status: "archived",
      }),
      owners.providerConnection(id(15), {
        credentialRef: reference(id(53), 2),
        status: "disconnected",
      }),
      owners.providerConnection(id(16), {
        authMethod: "oauth2",
        credentialRef: reference(id(54), 2),
        status: "reauthorization-required",
      }),
      owners.toolAdapter(id(17), { authSecretRef: reference(id(55), 0), status: "archived" }),
      owners.toolAdapter(id(18), { authSecretRef: reference(id(56), 0), status: "disabled" }),
      owners.webhookEndpoint(id(19), { status: "archived" }),
    ]);

    expect(
      page.items.map((item) => [item.ownerId, item.ownerStatus, item.status, item.purpose]),
    ).toEqual([
      // Archiving a channel binding keeps its credential until the credential is revoked.
      [id(10), "archived", "active", "channel-runtime"],
      [id(12), "archived", "revoked", "mcp-server-auth"],
      [id(14), "archived", "revoked", "provider-oauth-client-secret"],
      [id(15), "disconnected", "revoked", "provider-api"],
      [id(16), "reauthorization-required", "active", "provider-oauth-token"],
      [id(17), "archived", "revoked", "extension-callback-auth"],
      [id(18), "disabled", "active", "extension-callback-auth"],
      [id(19), "archived", "revoked", "webhook-signing"],
    ]);
  });

  test("pages across owner types without duplicates or gaps", async () => {
    for (const limit of [1, 2, 3, 5, 7]) {
      expect(await walk(environmentRecords(), limit), `limit ${limit}`).toEqual([
        ...EXPECTED_ITEMS,
      ]);
    }
  });

  test("filters by owner type and pages within it", async () => {
    expect(await walk(environmentRecords(), 1, "provider-connection")).toEqual(
      EXPECTED_ITEMS.filter((item) => item.ownerType === "provider-connection"),
    );
    expect((await list(environmentRecords(), { ownerType: "webhook-endpoint" })).items).toEqual(
      EXPECTED_ITEMS.filter((item) => item.ownerType === "webhook-endpoint"),
    );
  });

  test("bounds storage reads per request and resumes after owners without references", async () => {
    const records = [
      ...Array.from({ length: 12 }, (_, index) => owners.toolAdapter(id(30 + index))),
      owners.toolAdapter(id(42), { authSecretRef: reference(id(70), 0) }),
    ];

    const first = await list(records, { limit: 1, ownerType: "tool-adapter" });
    expect(first.items).toEqual([]);
    expect(first.next).toEqual({ ownerId: id(39), ownerType: "tool-adapter" });

    const second = await list(records, {
      after: first.next!,
      limit: 1,
      ownerType: "tool-adapter",
    });
    expect(second.items.map((item) => item.credentialId)).toEqual([id(70)]);
    expect(second.next).toBeUndefined();
  });

  test("rejects a position outside the filtered owner types", async () => {
    expect(
      list(environmentRecords(), {
        after: { ownerType: "mcp-server" },
        ownerType: "webhook-endpoint",
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", kind: "invalid-input" });
  });
});
