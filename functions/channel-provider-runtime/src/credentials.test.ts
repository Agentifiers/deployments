import { describe, expect, test } from "bun:test";

import type {
  CredentialVaultService,
  CredentialVaultWriteRequest,
} from "@deployments-ai/credential-vault";
import { makeOrganizationHoldReader, type OrganizationHoldReader } from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import type { Ulid } from "@deployments-ai/db/ids";
import { organizationHolds } from "@deployments-ai/organization-admission/testing";

import { handleCredentialApi, type CredentialApiEvent } from "./credentials.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const CREDENTIAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const OWNER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const standing: OrganizationHoldReader = { read: async () => ({ state: "active" }) };

function event(method: string, body?: Record<string, unknown>): CredentialApiEvent {
  return {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    pathParameters: {
      credentialId: CREDENTIAL_ID,
      environmentId: ENVIRONMENT_ID,
    },
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            organization_id: ORGANIZATION_ID,
            project_id: PROJECT_ID,
          },
        },
      },
      http: { method },
    },
  };
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: OWNER_ID,
    ownerType: "provider-connection",
    purpose: "provider-api",
    values: { clientSecret: "never-return-this" },
    ...overrides,
  };
}

function vault(overrides: Partial<CredentialVaultService> = {}): CredentialVaultService {
  return {
    prepareRevoke: async () => {
      throw new Error("not used");
    },
    prepareWrite: async () => {
      throw new Error("not used");
    },
    read: async () => {
      throw new Error("not used");
    },
    revoke: async () => undefined,
    write: async () => ({
      credentialId: CREDENTIAL_ID as never,
      generation: 0,
      store: "dynamodb-kms",
    }),
    ...overrides,
  };
}

describe("credential API", () => {
  test("atomically attaches prepared credentials in the production mutation branch", async () => {
    let committed: unknown;
    const result = await handleCredentialApi(event("POST", requestBody()), {
      commit: async (mutation) => {
        committed = mutation;
      },
      standing,
      vault: vault({
        prepareWrite: async () => ({
          operation: { kind: "put", record: {} as never },
          reference: {
            credentialId: CREDENTIAL_ID,
            generation: 0,
            store: "dynamodb-kms",
          },
        }),
      }),
    });

    expect(result.statusCode).toBe(201);
    expect(committed).toMatchObject({
      action: "created",
      ownerId: OWNER_ID,
      ownerType: "provider-connection",
      scope: {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
    });
  });

  test("requires organization and project claims", async () => {
    let called = false;
    const result = await handleCredentialApi(
      {
        ...event("POST", requestBody()),
        requestContext: { http: { method: "POST" } },
      },
      {
        vault: vault({
          write: async () => {
            called = true;
            throw new Error("must not be called");
          },
        }),
      },
    );

    expect(result.statusCode).toBe(401);
    expect(result.body).toBe('{"error":"unauthorized"}');
    expect(called).toBe(false);
  });

  test("creates an org-scoped credential and returns only its pinned reference", async () => {
    let request: CredentialVaultWriteRequest | undefined;
    const result = await handleCredentialApi(event("POST", requestBody()), {
      standing,
      vault: vault({
        write: async (value) => {
          request = value;
          return {
            credentialId: CREDENTIAL_ID as never,
            generation: 0,
            store: "dynamodb-kms",
          };
        },
      }),
    });

    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body ?? "{}")).toEqual({
      reference: {
        credentialId: CREDENTIAL_ID,
        generation: 0,
        store: "dynamodb-kms",
      },
    });
    expect(result.body).not.toContain("never-return-this");
    expect(request?.identity.organizationId).toBe(ORGANIZATION_ID);
    expect(request?.identity.projectId).toBe(PROJECT_ID);
    expect(request?.expectedGeneration).toBeUndefined();
  });

  test("rejects the internal provider request header envelope", async () => {
    let written = false;
    const result = await handleCredentialApi(
      event(
        "POST",
        requestBody({
          values: {
            "deploymentsAi.providerRequestHeaders": '{"x-http-method-override":"POST"}',
          },
        }),
      ),
      {
        standing,
        vault: vault({
          write: async () => {
            written = true;
            throw new Error("must not write a reserved field");
          },
        }),
      },
    );

    expect(result.statusCode).toBe(400);
    expect(written).toBe(false);
  });

  test("requires and forwards the expected generation for rotation", async () => {
    let request: CredentialVaultWriteRequest | undefined;
    const missing = await handleCredentialApi(event("PUT", requestBody()), {
      standing,
      vault: vault({
        write: async (value) => {
          request = value;
          return {
            credentialId: CREDENTIAL_ID as never,
            generation: 3,
            store: "dynamodb-kms",
          };
        },
      }),
    });
    expect(missing.statusCode).toBe(400);
    expect(request).toBeUndefined();

    const rotated = await handleCredentialApi(
      event("PUT", requestBody({ expectedGeneration: 2 })),
      {
        standing,
        vault: vault({
          write: async (value) => {
            request = value;
            return {
              credentialId: CREDENTIAL_ID as never,
              generation: 3,
              store: "dynamodb-kms",
            };
          },
        }),
      },
    );
    expect(rotated.statusCode).toBe(200);
    expect(request?.expectedGeneration).toBe(2);
  });

  test("revokes only the generation supplied by the caller", async () => {
    let revoked: Parameters<CredentialVaultService["revoke"]>[0] | undefined;
    const result = await handleCredentialApi(
      {
        ...event("DELETE"),
        queryStringParameters: { generation: "4" },
      },
      {
        standing,
        vault: vault({
          revoke: async (request) => {
            revoked = request;
          },
        }),
      },
    );

    expect(result.statusCode).toBe(204);
    expect(revoked?.organizationId).toBe(ORGANIZATION_ID);
    expect(revoked?.reference).toEqual({
      credentialId: CREDENTIAL_ID,
      generation: 4,
      store: "dynamodb-kms",
    });
  });

  test("refuses writes while the organization is held, still revokes, and writes after release", async () => {
    const memory = evaluationMemoryDatabase([]);
    const holds = organizationHolds(memory.database, ORGANIZATION_ID);
    const dependencies = { standing: makeOrganizationHoldReader(memory.database), vault: vault() };
    const withRequestId = (request: CredentialApiEvent): CredentialApiEvent => ({
      ...request,
      requestContext: { ...request.requestContext, requestId: "request-1" },
    });

    await holds.hold("payment");
    const created = await handleCredentialApi(
      withRequestId(event("POST", requestBody())),
      dependencies,
    );
    const rotated = await handleCredentialApi(
      event("PUT", requestBody({ expectedGeneration: 2 })),
      dependencies,
    );
    const revoked = await handleCredentialApi(
      { ...event("DELETE"), queryStringParameters: { generation: "4" } },
      dependencies,
    );
    await holds.release("payment");
    const recreated = await handleCredentialApi(event("POST", requestBody()), dependencies);

    expect([created, rotated, revoked, recreated].map((result) => result.statusCode)).toEqual([
      403, 403, 204, 201,
    ]);
    expect(Object.entries(created.headers ?? {})).toEqual([
      ["content-type", "application/problem+json"],
      ["x-request-id", "request-1"],
    ]);
    expect(JSON.parse(created.body ?? "{}")).toEqual({
      code: "organization_suspended",
      detail:
        "This organization can read its data and reduce access or activity, but cannot make other changes until every hold is released.",
      holds: [
        {
          customerMessage: "Update your payment method.",
          reason: "payment",
          since: expect.any(String),
        },
      ],
      requestId: "request-1",
      status: 403,
      title: "The organization is suspended.",
      type: "https://docs.deployments.ai/errors/organization-suspended",
    });
  });
});
