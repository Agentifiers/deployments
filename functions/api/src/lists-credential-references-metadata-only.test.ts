import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_REFERENCE_OWNER_TYPES,
  decodePlatformRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { HOSTED_CODE_SECRETS_VAULT_PURPOSE } from "@deployments-ai/tools";
import { Effect } from "effect";
import { createAdministrationApi, type AdministrationInvocation } from "./administration-api.ts";
import {
  makeAdministrationPersistence,
  type AdministrationEnvironment,
  type AdministrationPersistenceDependencies,
} from "./administration-persistence.ts";
import type { ApiIdentity } from "./index.ts";

const id = (index: number) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}` as Ulid;
const ORGANIZATION_ID = id(1);
const PROJECT_ID = id(2);
const ENVIRONMENT_ID = id(3);
const OTHER_ENVIRONMENT_ID = id(4);
const PRINCIPAL_ID = id(5);
const SECRET_MATERIAL = ["CIPHERTEXT-MUST-NOT-LEAK", "TAG-MUST-NOT-LEAK", "KEY-MUST-NOT-LEAK"];

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
          createdAt: "2026-09-01T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          status: "active",
          updatedAt: "2026-09-02T00:00:00.000Z",
          version: 1,
          ...data,
        },
        itemType,
      }),
    ),
  );
}

/** One reference per durable owner type, a vault entry, and a foreign environment's owners. */
function seededRecords() {
  const ownersIn = (environmentId: Ulid, offset: number) => [
    record("channel-binding", {
      agentDefinitionId: id(90),
      channel: "slack",
      credentialRef: reference(id(offset + 10), 1),
      environmentId,
      id: id(offset),
      provider: "slack",
    }),
    record("mcp-server", {
      authSecretRef: reference(id(offset + 11), 2),
      endpointOrigin: "https://mcp.example.test",
      endpointPath: "/mcp",
      environmentId,
      id: id(offset + 1),
      name: "Customer MCP",
      toolAllowlist: [],
    }),
    record("provider-application", {
      clientId: "public-client-id",
      clientSecretRef: reference(id(offset + 12), 3),
      displayName: "Customer OAuth app",
      environmentId,
      id: id(offset + 2),
      providerKey: "github",
      redirectUris: ["https://app.example.test/oauth/callback"],
      requestedScopes: [],
    }),
    record("provider-connection", {
      authMethod: "static",
      credentialRef: reference(id(offset + 13), 0),
      environmentId,
      id: id(offset + 3),
      providerKey: "stripe",
      scopes: [],
      status: "disconnected",
    }),
    record("tool-adapter", {
      authSecretRef: reference(id(offset + 14), 5),
      effect: "execute",
      environmentId,
      execution: {
        contentHash: `sha256:${"b".repeat(64)}`,
        entrypoint: "handler",
        language: "javascript",
        memoryMiB: 256,
        network: "none",
        secretNames: ["API_TOKEN"],
        sourceLanguage: "typescript",
        timeoutMs: 5_000,
        type: "hosted_code",
      },
      id: id(offset + 4),
      name: "orders.lookup",
      requiredScopes: [],
    }),
    record("webhook-endpoint", {
      environmentId,
      eventTypes: ["run.completed"],
      id: id(offset + 5),
      name: "Run hook",
      signingSecretRef: reference(id(offset + 15), 0),
      url: "https://hooks.example.test/events",
    }),
  ];
  return [
    ...ownersIn(ENVIRONMENT_ID, 20),
    ...ownersIn(OTHER_ENVIRONMENT_ID, 50),
    record("credential-vault-entry", {
      algorithm: "AES-256-GCM",
      authTag: SECRET_MATERIAL[1],
      ciphertext: SECRET_MATERIAL[0],
      encryptedDataKey: SECRET_MATERIAL[2],
      encryptionContextHash: "context-hash",
      generation: 3,
      id: id(32),
      iv: "iv",
      kmsKeyArn: "arn:aws:kms:us-east-1:111122223333:key/vault",
      ownerId: id(22),
      ownerType: "provider-application",
      purpose: "provider-oauth-client-secret",
    }),
  ];
}

type ListRequest = (
  query?: string,
  environmentId?: Ulid,
) => Promise<{ readonly body: string; readonly status: number }>;

function api(scopes: readonly string[] = ["secrets:read"]): ListRequest {
  const environments: Readonly<Record<string, AdministrationEnvironment>> = Object.fromEntries(
    [ENVIRONMENT_ID, OTHER_ENVIRONMENT_ID].map((environmentId) => [
      environmentId,
      {
        id: environmentId,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        status: "active",
      },
    ]),
  );
  const identity: ApiIdentity = {
    environmentIds: [ENVIRONMENT_ID, OTHER_ENVIRONMENT_ID],
    principalId: PRINCIPAL_ID,
    scopes,
  };
  const fetch = createAdministrationApi({
    authenticate: async () => identity,
    authorize: async () => undefined,
    idempotency: { execute: async (input) => input.operation() },
    requestId: () => "request_test",
    service: makeAdministrationPersistence({
      database: evaluationMemoryDatabase(seededRecords()).database,
      resolveEnvironment: async (invocation: AdministrationInvocation) =>
        environments[invocation.scope.environmentId ?? ""],
    } as unknown as AdministrationPersistenceDependencies),
  });
  return async (query = "", environmentId: Ulid = ENVIRONMENT_ID) => {
    const response = await fetch(
      new Request(`https://api.example/v1/credential-references${query}`, {
        headers: { "x-deployments-environment": environmentId },
      }),
    );
    return { body: await response!.text(), status: response!.status };
  };
}

type Item = Readonly<Record<string, unknown>>;

async function listAll(request: ListRequest, limit: number) {
  const items: Item[] = [];
  const bodies: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await request(
      `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(response.status).toBe(200);
    bodies.push(response.body);
    const page = JSON.parse(response.body) as {
      readonly items: Item[];
      readonly nextCursor: string | null;
    };
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return { bodies, items };
}

describe("GET /v1/credential-references", () => {
  test("pages the environment's owner references as metadata only", async () => {
    const { bodies, items } = await listAll(api(), 2);

    expect(
      items.map((item) => [item.ownerType, item.ownerId, item.purpose, item.generation]),
    ).toEqual([
      ["channel-binding", id(20), "channel-runtime", 1],
      ["mcp-server", id(21), "mcp-server-auth", 2],
      ["provider-application", id(22), "provider-oauth-client-secret", 3],
      ["provider-connection", id(23), "provider-api", 0],
      ["tool-adapter", id(24), HOSTED_CODE_SECRETS_VAULT_PURPOSE, 5],
      ["webhook-endpoint", id(25), "webhook-signing", 0],
    ]);
    expect(items.map((item) => item.ownerType)).toEqual([...CREDENTIAL_REFERENCE_OWNER_TYPES]);
    expect(items.find((item) => item.ownerType === "provider-connection")).toMatchObject({
      ownerStatus: "disconnected",
      status: "revoked",
    });
    expect(items.find((item) => item.ownerType === "tool-adapter")?.secretNames).toEqual([
      "API_TOKEN",
    ]);
    for (const body of bodies) {
      for (const material of SECRET_MATERIAL) expect(body).not.toContain(material);
      for (const field of ["ciphertext", "authTag", "encryptedDataKey", "encryptionContextHash"]) {
        expect(body).not.toContain(`"${field}"`);
      }
    }
  });

  test("lists another environment only under that environment's scope", async () => {
    const request = api();
    const response = await request("?ownerType=mcp-server", OTHER_ENVIRONMENT_ID);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      items: [{ credentialId: id(61), ownerId: id(51) }],
      nextCursor: null,
    });
  });

  test("requires the secrets:read capability", async () => {
    const denied = await api(["providers:read", "tools:read"])();
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toMatchObject({ code: "insufficient_scope" });
    expect((await api(["secrets:read"])()).status).toBe(200);
  });

  test("rejects unknown owner types and cursors from another environment or filter", async () => {
    const request = api();
    const invalidType = await request("?ownerType=stream-session");
    expect(invalidType.status).toBe(400);
    expect(JSON.parse(invalidType.body)).toMatchObject({ code: "invalid_query_parameter" });

    const first = JSON.parse((await request("?limit=1")).body) as { readonly nextCursor: string };
    for (const [query, environmentId] of [
      [`?cursor=${encodeURIComponent(first.nextCursor)}`, OTHER_ENVIRONMENT_ID],
      [`?ownerType=channel-binding&cursor=${encodeURIComponent(first.nextCursor)}`, ENVIRONMENT_ID],
      ["?cursor=not-a-cursor", ENVIRONMENT_ID],
    ] as const) {
      const response = await request(query, environmentId);
      expect(response.status, query).toBe(400);
      expect(JSON.parse(response.body), query).toMatchObject({ code: "invalid_cursor" });
    }
  });
});
