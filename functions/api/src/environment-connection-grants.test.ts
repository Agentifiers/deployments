import { describe, expect, test } from "bun:test";
import type { PlatformRecord } from "@deployments-ai/db";
import { createAdministrationApi } from "./administration-api.ts";
import { makeAdministrationPersistence } from "./administration-persistence.ts";
import type { ApiIdentity } from "./index.ts";
import {
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  PROJECT_ID,
  memoryDatabase,
} from "./vendor-mcp-authorization.fixture.ts";

const WORKSPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const UNKNOWN_WORKSPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB9";

interface CallResult {
  readonly body: Record<string, unknown>;
  readonly status: number;
}

type Call = (method: string, path: string, body?: unknown) => Promise<CallResult>;

function harness(): Call {
  const { database } = memoryDatabase();
  let sequence = 0;
  const service = makeAdministrationPersistence({
    credentials: {
      prepareRevoke: async () => {
        throw new Error("unexpected credential revoke");
      },
      prepareWrite: async (input) => ({
        operation: {
          kind: "put",
          record: {
            data: { id: input.identity.credentialId },
            itemType: "credential-vault-entry",
            pk: `vault#${input.identity.credentialId}`,
            sk: `vault#${input.identity.credentialId}`,
          } as unknown as PlatformRecord,
        },
        reference: {
          credentialId: input.identity.credentialId,
          generation: 0,
          store: "dynamodb-kms" as const,
        },
      }),
      read: async () => ({ values: { apiKey: "rewardful-secret" } }),
    },
    database,
    generateId: async () => {
      sequence += 1;
      return `01ARZ3NDEKTSV4RRFFQ69G${String(sequence).padStart(4, "0")}`;
    },
    mcpDiscovery: {
      discover: async () => {
        throw new Error("unexpected MCP discovery");
      },
    },
    now: () => new Date("2026-10-18T12:00:00.000Z"),
    providerVerification: {
      verify: async (input) => ({
        externalAccountId: "rewardful-account",
        metadata: { method: input.definition.verification.method },
        scopes: input.connection.scopes,
      }),
    },
    resolveEnvironment: async () => ({
      id: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      status: "active",
    }),
    resolveWorkspace: async (_environment, workspaceId) => workspaceId === WORKSPACE_ID,
  });
  const fetch = createAdministrationApi({
    authenticate: async () =>
      ({
        environmentIds: [ENVIRONMENT_ID],
        principalId: PRINCIPAL_ID,
        scopes: ["platform:admin"],
      }) satisfies ApiIdentity,
    authorize: async () => undefined,
    idempotency: { execute: async (input) => input.operation() },
    requestId: () => "request_test",
    service,
  });
  let request = 0;
  return async (method: string, path: string, body?: unknown): Promise<CallResult> => {
    request += 1;
    const response = (await fetch(
      new Request(`https://api.example${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": `environment-grant-${request}`,
          "x-deployments-environment": ENVIRONMENT_ID,
        },
        method,
      }),
    ))!;
    return { body: (await response.json()) as Record<string, unknown>, status: response.status };
  };
}

async function connections(call: Call) {
  const callback = await call("POST", "/v1/credentials", {
    displayName: "Extension callbacks",
    providerKey: "extension_callback",
  });
  const credentialed = await call("POST", "/v1/credentials", {
    credential: "rewardful-secret",
    displayName: "Rewardful",
    providerKey: "rewardful",
  });
  const verification = await call(
    "POST",
    `/v1/connections/${String(credentialed.body.id)}/verify`,
    {},
  );
  expect([callback.status, credentialed.status, verification.status]).toEqual([201, 201, 202]);
  expect(verification.body.status).toBe("verified");
  return {
    callbackId: String(callback.body.id),
    credentialedId: String(credentialed.body.id),
    credentialedScopes: credentialed.body.scopes as readonly string[],
  };
}

describe("environment connection grants", () => {
  test("grants a credentialless connection to every workspace with workspaceId null", async () => {
    const call = harness();
    const { callbackId } = await connections(call);

    const created = await call("POST", "/v1/connection-grants", {
      connectionId: callbackId,
      purpose: "agent-runtime",
      scopes: ["callback:draft:propose"],
      workspaceId: null,
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      connectionId: callbackId,
      providerKey: "extension_callback",
      scopes: ["callback:draft:propose"],
      status: "active",
      workspaceId: null,
    });
    const shown = await call("GET", `/v1/connection-grants/${String(created.body.id)}`);
    expect(shown.status).toBe(200);
    expect(shown.body.workspaceId).toBeNull();
  });

  test("refuses an environment grant on a connection that uses a credential", async () => {
    const call = harness();
    const { credentialedId, credentialedScopes } = await connections(call);

    const refused = await call("POST", "/v1/connection-grants", {
      connectionId: credentialedId,
      purpose: "agent-runtime",
      scopes: credentialedScopes,
      workspaceId: null,
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      code: "environment_grant_requires_credentialless_connection",
      status: 422,
    });
  });

  test("keeps workspaceId a required key", async () => {
    const call = harness();
    const { callbackId } = await connections(call);

    const missing = await call("POST", "/v1/connection-grants", {
      connectionId: callbackId,
      purpose: "agent-runtime",
      scopes: ["callback:draft:propose"],
    });

    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({
      code: "validation_failed",
      detail: "The request did not match the API contract.",
      status: 422,
    });
  });

  test("still validates a named workspace", async () => {
    const call = harness();
    const { callbackId, credentialedId, credentialedScopes } = await connections(call);

    const unknown = await call("POST", "/v1/connection-grants", {
      connectionId: callbackId,
      purpose: "agent-runtime",
      scopes: ["callback:draft:propose"],
      workspaceId: UNKNOWN_WORKSPACE_ID,
    });
    const credentialed = await call("POST", "/v1/connection-grants", {
      connectionId: credentialedId,
      purpose: "agent-runtime",
      scopes: credentialedScopes,
      workspaceId: WORKSPACE_ID,
    });

    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: "resource_not_found" });
    expect(credentialed.status).toBe(201);
    expect(credentialed.body).toMatchObject({
      connectionId: credentialedId,
      providerKey: "rewardful",
      workspaceId: WORKSPACE_ID,
    });
  });
});
