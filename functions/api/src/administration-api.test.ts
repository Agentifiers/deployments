import { describe, expect, spyOn, test } from "bun:test";
import {
  PROVIDER_API_ROUTES,
  TOOL_CATALOG_API_ROUTES,
  TOOLING_API_ROUTES,
} from "@deployments-ai/api-contract";
import { PersistenceError } from "@deployments-ai/db";
import { createAdministrationApi } from "./administration-api.ts";
import type { ApiIdentity } from "./index.ts";

const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const OTHER_ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

const identity = {
  environmentIds: [ENVIRONMENT_ID],
  principalId: PRINCIPAL_ID,
  scopes: ["platform:admin"],
} as const satisfies ApiIdentity;

function api(
  overrides: {
    readonly invoke?: (
      routeName: string,
      invocation?: { readonly body: unknown },
    ) => Promise<unknown>;
    readonly authenticate?: () => Promise<ApiIdentity | null>;
    readonly authorize?: Parameters<typeof createAdministrationApi>[0]["authorize"];
    readonly idempotency?: Parameters<typeof createAdministrationApi>[0]["idempotency"];
    readonly recordApiCredentialUsage?: Parameters<
      typeof createAdministrationApi
    >[0]["recordApiCredentialUsage"];
  } = {},
) {
  return createAdministrationApi({
    authenticate: overrides.authenticate ?? (async () => identity),
    authorize: overrides.authorize ?? (async () => undefined),
    idempotency: overrides.idempotency ?? { execute: async (input) => input.operation() },
    ...(overrides.recordApiCredentialUsage
      ? { recordApiCredentialUsage: overrides.recordApiCredentialUsage }
      : {}),
    requestId: () => "request_test",
    service: {
      invoke: overrides.invoke ?? (async () => ({})),
    },
  });
}

describe("administration API dispatcher", () => {
  test("recognizes every provider, tooling, and tool catalog route", async () => {
    const fetch = api();
    for (const route of [
      ...PROVIDER_API_ROUTES,
      ...TOOLING_API_ROUTES,
      ...TOOL_CATALOG_API_ROUTES,
    ]) {
      const path = route.path.replaceAll(/:[^/]+/gu, ENVIRONMENT_ID);
      const response = await fetch(
        new Request(`https://api.example${path}`, { method: route.method }),
      );
      expect(response, route.name).toBeDefined();
      expect(response!.status, route.name).not.toBe(404);
    }
  });

  test("evaluates tool policies as a read: tools:read, no idempotency key, not a mutation", async () => {
    const authorizations: boolean[] = [];
    const request = () =>
      new Request("https://api.example/v1/tool-policies/evaluate", {
        body: JSON.stringify({ agentDeploymentId: ENVIRONMENT_ID }),
        headers: { "x-deployments-environment": ENVIRONMENT_ID },
        method: "POST",
      });
    const fetch = (scopes: readonly string[]) =>
      api({
        authenticate: async () => ({ ...identity, scopes }),
        authorize: async (_invocation, _routeName, mutation) => {
          authorizations.push(mutation);
        },
        invoke: async (routeName) => {
          expect(routeName).toBe("evaluateToolPolicy");
          return { results: [] };
        },
      });
    expect((await fetch(["tools:read"])(request()))?.status).toBe(200);
    expect(authorizations).toEqual([false]);
    expect((await fetch(["tools:write"])(request()))?.status).toBe(403);
  });

  test("keeps public provider discovery independent of authentication and environment scope", async () => {
    let authenticationCalls = 0;
    const fetch = api({
      authenticate: async () => {
        authenticationCalls += 1;
        return null;
      },
      invoke: async (routeName) => {
        expect(routeName).toBe("listProviders");
        return { items: [], nextCursor: null };
      },
    });
    const response = await fetch(new Request("https://api.example/v1/providers"));
    expect(response?.status).toBe(200);
    expect(authenticationCalls).toBe(0);
  });

  test("records authenticated API credential usage for administration routes", async () => {
    const usage: Parameters<
      NonNullable<Parameters<typeof createAdministrationApi>[0]["recordApiCredentialUsage"]>
    >[0][] = [];
    const apiCredentialId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    const fetch = api({
      authenticate: async () => ({
        apiCredentialId,
        authentication: "api-credential",
        environmentIds: [ENVIRONMENT_ID],
        organizationIds: [organizationId],
        principalId: PRINCIPAL_ID,
        projectIds: [projectId],
        scopes: ["platform:admin"],
      }),
      invoke: async () => ({ items: [], nextCursor: null }),
      recordApiCredentialUsage: async (input) => {
        usage.push(input);
      },
    });

    const response = await fetch(
      new Request("https://api.example/v1/credentials", {
        headers: { "x-deployments-environment": ENVIRONMENT_ID },
      }),
    );

    expect(response?.status).toBe(200);
    expect(usage).toEqual([
      {
        apiCredentialId,
        environmentId: ENVIRONMENT_ID,
        organizationId,
        outcome: "allowed",
        projectId,
        requestMethod: "GET",
        requestPath: "/v1/credentials",
      },
    ]);
  });

  test("requires authentication, environment context, and idempotency before mutations", async () => {
    const unauthenticated = api({ authenticate: async () => null });
    expect(
      (
        await unauthenticated(
          new Request("https://api.example/v1/tool-policies", { method: "POST" }),
        )
      )?.status,
    ).toBe(401);

    const fetch = api();
    expect(
      (await fetch(new Request("https://api.example/v1/tool-policies", { method: "POST" })))
        ?.status,
    ).toBe(400);
    expect(
      (
        await fetch(
          new Request("https://api.example/v1/tool-policies", {
            headers: { "x-deployments-environment": ENVIRONMENT_ID },
            method: "POST",
          }),
        )
      )?.status,
    ).toBe(400);
    const malformedEnvironment = await fetch(
      new Request("https://api.example/v1/tool-policies", {
        headers: { "x-deployments-environment": "not-an-environment-id" },
      }),
    );
    expect(malformedEnvironment?.status).toBe(400);
    expect(await malformedEnvironment!.json()).toMatchObject({
      code: "invalid_environment_context",
    });
  });

  test("requires provider and tooling write scopes before administration mutations", async () => {
    const fetch = api({
      authenticate: async () => ({
        ...identity,
        scopes: ["providers:read", "tools:read"],
      }),
      invoke: async () => {
        throw new Error("A scope-rejected request must not reach persistence.");
      },
    });
    for (const path of ["/v1/credentials", "/v1/extensions"]) {
      const response = await fetch(
        new Request(`https://api.example${path}`, {
          headers: {
            "idempotency-key": "write-with-read-scope",
            "x-deployments-environment": ENVIRONMENT_ID,
          },
          method: "POST",
        }),
      );
      expect(response?.status, path).toBe(403);
      expect(await response!.json(), path).toMatchObject({ code: "insufficient_scope" });
    }
  });

  test("decodes absent optional mutation bodies as empty objects", async () => {
    let invocationBody: unknown;
    let authorization: readonly [string, boolean] | undefined;
    const response = await api({
      authorize: async (_invocation, routeName, mutation) => {
        authorization = [routeName, mutation];
      },
      invoke: async (routeName, invocation) => {
        expect(routeName).toBe("requestConnectionVerification");
        invocationBody = invocation?.body;
        return {
          connectionId: ENVIRONMENT_ID,
          createdAt: "2026-07-26T12:00:00.000Z",
          id: OTHER_ENVIRONMENT_ID,
          providerKey: "github",
          status: "pending",
          updatedAt: "2026-07-26T12:00:00.000Z",
          version: 0,
        };
      },
    })(
      new Request(`https://api.example/v1/connections/${ENVIRONMENT_ID}/verify`, {
        headers: {
          "idempotency-key": "verify-without-body",
          "x-deployments-environment": ENVIRONMENT_ID,
        },
        method: "POST",
      }),
    );

    expect(response?.status).toBe(202);
    expect(invocationBody).toEqual({});
    expect(authorization).toEqual(["requestConnectionVerification", true]);
  });

  test("marks administration reads as non-mutating authorization checks", async () => {
    let authorization: readonly [string, boolean] | undefined;
    const response = await api({
      authorize: async (_invocation, routeName, mutation) => {
        authorization = [routeName, mutation];
      },
      invoke: async () => ({ items: [], nextCursor: null }),
    })(
      new Request("https://api.example/v1/credentials", {
        headers: { "x-deployments-environment": ENVIRONMENT_ID },
      }),
    );

    expect(response?.status).toBe(200);
    expect(authorization).toEqual(["listProviderCredentials", false]);
  });

  test("maps persistence conflicts to public problem details", async () => {
    const fetch = api({
      invoke: async () => {
        throw new PersistenceError("conflict", "version_conflict", "Version changed.");
      },
    });
    const response = await fetch(
      new Request(`https://api.example/v1/tool-policies/${ENVIRONMENT_ID}`, {
        headers: { "x-deployments-environment": ENVIRONMENT_ID },
      }),
    );
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({
      code: "version_conflict",
      requestId: "request_test",
      status: 409,
    });
  });

  test("distinguishes request validation from internal service failures", async () => {
    const invalid = await api()(
      new Request("https://api.example/v1/tool-policies", {
        body: JSON.stringify({ name: "", policy: { rules: [] } }),
        headers: {
          "idempotency-key": "invalid-request",
          "x-deployments-environment": ENVIRONMENT_ID,
        },
        method: "POST",
      }),
    );
    expect(invalid?.status).toBe(422);

    const failed = await api({
      invoke: async () => {
        throw new TypeError("internal persistence defect");
      },
    })(new Request("https://api.example/v1/providers"));
    expect(failed?.status).toBe(500);
    expect(await failed!.json()).toMatchObject({ code: "internal_error" });
  });

  test("logs one bounded cause for an internal service failure", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = await api({
        invoke: async () => {
          throw new TypeError("internal persistence defect");
        },
      })(new Request("https://api.example/v1/providers"));
      expect(failed?.status).toBe(500);
      expect(consoleError.mock.calls).toEqual([
        [
          "Administration API request failed.",
          {
            error: "internal persistence defect",
            errorType: "TypeError",
            requestId: "request_test",
            route: "listProviders",
          },
        ],
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("rejects malformed and out-of-range list limits", async () => {
    const fetch = api({
      invoke: async () => ({ items: [], nextCursor: null }),
    });
    for (const limit of ["0", "101", "abc"]) {
      const response = await fetch(
        new Request(`https://api.example/v1/tool-policies?limit=${limit}`, {
          headers: { "x-deployments-environment": ENVIRONMENT_ID },
        }),
      );
      expect(response?.status, limit).toBe(400);
      expect(await response!.json(), limit).toMatchObject({ code: "invalid_limit" });
    }
  });

  test("returns a problem response for malformed encoded path parameters", async () => {
    const response = await api()(new Request("https://api.example/v1/providers/%"));
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ code: "invalid_path_parameter" });
  });

  test("namespaces idempotency records and fingerprints by environment", async () => {
    const fingerprints: string[] = [];
    const keys: string[] = [];
    const fetch = api({
      idempotency: {
        execute: async (input) => {
          fingerprints.push(input.fingerprint);
          keys.push(input.key);
          return input.operation();
        },
      },
      invoke: async () => ({
        createdAt: "2026-07-26T12:00:00.000Z",
        id: ENVIRONMENT_ID,
        name: "Default",
        policy: { defaultAction: "deny", rules: [] },
        status: "active",
        updatedAt: "2026-07-26T12:00:00.000Z",
        version: 0,
      }),
    });
    const body = JSON.stringify({
      name: "Default",
      policy: { defaultAction: "deny", rules: [] },
    });
    for (const environmentId of [ENVIRONMENT_ID, OTHER_ENVIRONMENT_ID]) {
      const response = await fetch(
        new Request("https://api.example/v1/tool-policies", {
          body,
          headers: {
            "content-type": "application/json",
            "idempotency-key": "same-key",
            "x-deployments-environment": environmentId,
          },
          method: "POST",
        }),
      );
      expect(response?.status).toBe(201);
    }
    const alternateKeyResponse = await fetch(
      new Request("https://api.example/v1/tool-policies", {
        body,
        headers: {
          "content-type": "application/json",
          "idempotency-key": "different-key",
          "x-deployments-environment": ENVIRONMENT_ID,
        },
        method: "POST",
      }),
    );
    expect(alternateKeyResponse?.status).toBe(201);
    expect(fingerprints).toHaveLength(3);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
    expect(fingerprints[0]).not.toBe(fingerprints[2]);
    expect(keys).toHaveLength(3);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("ignores idempotency headers on routes that do not declare idempotency", async () => {
    let idempotencyCalls = 0;
    let serviceCalls = 0;
    const fetch = api({
      idempotency: {
        execute: async (input) => {
          idempotencyCalls += 1;
          return input.operation();
        },
      },
      invoke: async (routeName) => {
        expect(routeName).toBe("listProviderCredentials");
        serviceCalls += 1;
        return { items: [], nextCursor: null };
      },
    });
    const request = () =>
      new Request("https://api.example/v1/credentials", {
        headers: {
          "idempotency-key": "globally-attached-key",
          "x-deployments-environment": ENVIRONMENT_ID,
        },
      });

    expect((await fetch(request()))?.status).toBe(200);
    expect((await fetch(request()))?.status).toBe(200);
    expect(idempotencyCalls).toBe(0);
    expect(serviceCalls).toBe(2);
  });
});
