import {
  Ulid,
  key,
  makeDynamoDatabase,
  makeModelProviderCredentialPersistence,
  makeTenancyPersistence,
  tableNamesFromEnvironment,
  type ByokProvider,
  type OrganizationRole,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { humanPrincipalRecord } from "@deployments-ai/db/memory-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { ApiIdentity } from "./api-service-contracts.ts";
import { ModelProviderUnavailableError, type ModelKeyVerdict } from "./model-credential-probe.ts";
import { createModelCredentialsApi } from "./model-credentials-api.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const OWNER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA0");
const ADMIN = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA1");
const MEMBER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA2");
const VIEWER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA3");
const FIRST_KEY = "sk-proj-first-secret-key-1111";
const SECOND_KEY = "sk-proj-second-secret-key-2222";

let sequence = 0;

async function setup(
  options: {
    readonly providers?: readonly ByokProvider[];
    readonly verdict?: () => Promise<ModelKeyVerdict>;
  } = {},
) {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  fake.put(tables.control, humanPrincipalRecord(OWNER, "owner@acme.example"));
  const database = makeDynamoDatabase(fake.client, tables);
  const acme = ulid(
    (
      await makeTenancyPersistence({ database }).organizations.create({
        body: { name: "Acme" },
        identity: { principalId: OWNER, scopes: ["platform:*"] },
        idempotencyKey: `organization-${++sequence}`,
        query: {},
        scope: {},
      })
    ).id,
  );
  const human = (principalId: Ulid, organizationRole: OrganizationRole): ApiIdentity => ({
    authentication: "tenant-jwt",
    organizationIds: [acme],
    organizationRole,
    principalId,
    scopes: ["models:read", "models:write"],
  });
  const identities: Readonly<Record<string, ApiIdentity>> = {
    admin: human(ADMIN, "admin"),
    member: human(MEMBER, "member"),
    owner: human(OWNER, "owner"),
    viewer: human(VIEWER, "viewer"),
  };
  const sealed: { readonly binding: Readonly<Record<string, string>>; readonly value: unknown }[] =
    [];
  const probes: [ByokProvider, string][] = [];
  const providers = options.providers ?? ["openai", "openrouter"];
  const handler = createModelCredentialsApi({
    authenticate: async (request) => identities[request.headers.get("authorization") ?? ""] ?? null,
    idempotency: { execute: async (input) => input.operation() },
    requestId: () => "req-test",
    ...(providers.length === 0
      ? {}
      : {
          store: {
            credentials: makeModelProviderCredentialPersistence({
              database,
              envelope: {
                encrypt: async (value, binding) => {
                  sealed.push({ binding, value });
                  return {
                    algorithm: "AES-256-GCM",
                    authenticationTag: "tag",
                    ciphertext: `sealed-${sealed.length}`,
                    encryptedDataKey: `data-key-${sealed.length}`,
                    encryptionContextHash: "context-hash",
                    iv: "iv",
                    schemaVersion: 1,
                  };
                },
              },
            }),
            probe: async (provider, apiKey) => {
              probes.push([provider, apiKey]);
              return (options.verdict ?? (async () => "accepted" as const))();
            },
            providers: new Set(providers),
          },
        }),
  });
  const send = async (caller: string, method: string, path: string, body?: unknown) => {
    const response = await handler(
      new Request(`https://api.example.test/v1/organizations/${acme}/model-credentials${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          authorization: caller,
          "x-deployments-organization": acme,
          ...(method === "GET" ? {} : { "idempotency-key": `key-${++sequence}` }),
        },
        method,
      }),
    );
    if (!response) throw new Error(`No route handled ${method} ${path}`);
    const text = await response.text();
    return { body: JSON.parse(text) as Record<string, any>, status: response.status, text };
  };
  const stored = (provider: ByokProvider) =>
    database.getRecord("control", {
      pk: key("ORG", acme),
      sk: key("MODEL-PROVIDER-CREDENTIAL", provider),
    });
  return { acme, probes, sealed, send, stored };
}

describe("organization model credentials API", () => {
  test("refuses viewers and members on every route", async () => {
    const { send } = await setup();

    for (const caller of ["viewer", "member"]) {
      for (const [method, path, body] of [
        ["GET", ""],
        ["GET", "/openai"],
        ["PUT", "/openai", { apiKey: FIRST_KEY }],
        ["DELETE", "/openai"],
      ] as const) {
        const response = await send(caller, method, path, body);
        expect([caller, method, path, response.status, response.body.code]).toEqual([
          caller,
          method,
          path,
          403,
          "insufficient_role",
        ]);
      }
    }
  });

  test("stores a verified key sealed to the organization and provider and never returns it", async () => {
    const { acme, probes, sealed, send } = await setup();

    const put = await send("owner", "PUT", "/openai", { apiKey: FIRST_KEY, label: "Production" });
    const credentialId = put.body.credentialId as string;

    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      createdAt: put.body.createdAt,
      credentialId,
      keyVersion: 1,
      label: "Production",
      lastFour: "1111",
      provider: "openai",
      setAt: put.body.createdAt,
      setBy: OWNER,
      status: "active",
      updatedAt: put.body.createdAt,
      version: 1,
    });
    expect(probes).toEqual([["openai", FIRST_KEY]]);
    expect(sealed).toEqual([
      {
        binding: {
          credentialId,
          keyVersion: "1",
          organizationId: acme,
          provider: "openai",
          purpose: "model-provider-credential",
        },
        value: FIRST_KEY,
      },
    ]);
    const reads = [put, await send("owner", "GET", ""), await send("admin", "GET", "/openai")];
    expect(reads.map((read) => read.status)).toEqual([200, 200, 200]);
    expect(reads[1]!.body).toEqual({ items: [reads[2]!.body] });
    for (const read of reads) {
      for (const secret of [FIRST_KEY, "sealed-1", "data-key-1", "ciphertext", "envelope"]) {
        expect(read.text).not.toContain(secret);
      }
    }
  });

  test("replacing a key bumps its version and changes the stored ciphertext", async () => {
    const { send, stored } = await setup();

    const first = await send("owner", "PUT", "/openrouter", { apiKey: FIRST_KEY });
    const before = await stored("openrouter");
    const second = await send("admin", "PUT", "/openrouter", { apiKey: SECOND_KEY });
    const after = await stored("openrouter");

    expect(second.body).toMatchObject({
      credentialId: first.body.credentialId,
      keyVersion: 2,
      lastFour: "2222",
      setBy: ADMIN,
      status: "active",
    });
    expect([before?.data, after?.data]).toMatchObject([
      { state: { envelope: { ciphertext: "sealed-1" }, kind: "active" } },
      { state: { envelope: { ciphertext: "sealed-2" }, kind: "active" } },
    ]);
  });

  test("removing a key clears its ciphertext and keeps its metadata", async () => {
    const { send, stored } = await setup();

    await send("owner", "PUT", "/openai", { apiKey: FIRST_KEY });
    const removed = await send("admin", "DELETE", "/openai");
    const record = await stored("openai");

    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({
      keyVersion: 1,
      lastFour: "1111",
      revokedBy: ADMIN,
      status: "revoked",
    });
    expect(record?.itemType === "model-provider-credential" && record.data.state).toEqual({
      kind: "revoked",
      revokedAt: removed.body.revokedAt,
      revokedBy: ADMIN,
    });
    expect(JSON.stringify(record)).not.toContain("sealed-1");
    expect((await send("owner", "DELETE", "/missing-provider")).body.code).toBe(
      "model_credentials_not_enabled",
    );
  });

  test("stores nothing when the provider rejects the key", async () => {
    const { probes, sealed, send, stored } = await setup({ verdict: async () => "rejected" });

    const put = await send("owner", "PUT", "/openai", { apiKey: FIRST_KEY });

    expect([put.status, put.body.code, put.body.detail]).toEqual([
      422,
      "model_credential_rejected",
      "The openai API rejected the key, so it was not stored.",
    ]);
    expect(probes).toEqual([["openai", FIRST_KEY]]);
    expect(sealed).toEqual([]);
    expect(await stored("openai")).toBeUndefined();
    expect((await send("owner", "GET", "/openai")).body.code).toBe("model_credential_not_found");
  });

  test("stores nothing when the provider cannot be reached", async () => {
    const { sealed, send, stored } = await setup({
      verdict: async () => {
        throw new ModelProviderUnavailableError("openai");
      },
    });

    const put = await send("owner", "PUT", "/openai", { apiKey: FIRST_KEY });

    expect([put.status, put.body.code]).toEqual([502, "model_provider_unavailable"]);
    expect(sealed).toEqual([]);
    expect(await stored("openai")).toBeUndefined();
  });

  test("refuses every route with a typed 404 when the installation enables no provider", async () => {
    const { send } = await setup({ providers: [] });

    for (const [method, path] of [
      ["GET", ""],
      ["GET", "/openai"],
      ["PUT", "/openai"],
      ["DELETE", "/openai"],
    ] as const) {
      const response = await send("owner", method, path, { apiKey: FIRST_KEY });
      expect([method, path, response.status, response.body.code, response.body.detail]).toEqual([
        method,
        path,
        404,
        "model_credentials_not_enabled",
        "Bring-your-own model keys are not enabled on this installation.",
      ]);
    }
  });

  test("refuses a provider the installation did not enable and lists only enabled ones", async () => {
    const { probes, send } = await setup({ providers: ["openai"] });

    const put = await send("owner", "PUT", "/openrouter", { apiKey: FIRST_KEY });

    expect([put.status, put.body.code, put.body.detail]).toEqual([
      404,
      "model_credentials_not_enabled",
      "Bring-your-own model keys are not enabled for openrouter on this installation.",
    ]);
    expect(probes).toEqual([]);
    expect((await send("owner", "GET", "")).body).toEqual({ items: [] });
  });
});
