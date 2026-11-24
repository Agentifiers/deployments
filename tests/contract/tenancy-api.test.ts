import { describe, expect, test } from "bun:test";
import { TENANCY_API_ROUTES } from "@deployments-ai/api-contract";
import { TenancyHttpApi } from "@deployments-ai/api";
import { createTenancyContractFixture } from "@deployments-ai/testkit";

const base = "https://api.example.test";
type JsonObject = Record<string, unknown>;

function jsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected the API response body to be a JSON object.");
  }
  return value as JsonObject;
}

function stringField(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new TypeError(`Expected response field ${field} to be a string.`);
  }
  return value;
}

function client(fetch: (request: Request) => Promise<Response>, token: string) {
  return async (
    method: string,
    path: string,
    options: { body?: unknown; idem?: string; scope?: Record<string, string> } = {},
  ) => {
    const response = await fetch(
      new Request(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(options.idem ? { "idempotency-key": options.idem } : {}),
          ...options.scope,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
    return { response, body: jsonObject(await response.json()) };
  };
}

describe("public tenancy API contract", () => {
  test("passes exact HTTP mutation metadata into live tenancy authorization", async () => {
    const authorizations: { mutation: boolean; operationName: string }[] = [];
    const fixture = createTenancyContractFixture({
      authorize: async (_invocation, operationName, mutation) => {
        authorizations.push({ mutation, operationName });
      },
    });
    const api = client(fixture.fetch, fixture.adminToken);
    const organization = await api("POST", "/v1/organizations", {
      body: { name: "Authorization Metadata" },
      idem: "authorization-metadata",
    });
    stringField(organization.body, "id");

    expect(authorizations).toEqual([{ mutation: true, operationName: "createOrganization" }]);
  });

  test("declares every tenancy operation through Effect HttpApi", () => {
    const tenancyGroup = TenancyHttpApi.groups.tenancy;
    const agentsGroup = TenancyHttpApi.groups.agents;
    const workflowsGroup = TenancyHttpApi.groups.workflows;
    const managedSkillsGroup = TenancyHttpApi.groups.managedSkills;
    if (!tenancyGroup) throw new TypeError("Tenancy HttpApi group is missing.");
    if (!agentsGroup) throw new TypeError("Agents HttpApi group is missing.");
    if (!workflowsGroup) throw new TypeError("Workflows HttpApi group is missing.");
    if (!managedSkillsGroup) throw new TypeError("Managed skills HttpApi group is missing.");
    expect(
      [
        ...Object.keys(tenancyGroup.endpoints),
        ...Object.keys(agentsGroup.endpoints),
        ...Object.keys(workflowsGroup.endpoints),
        ...Object.keys(managedSkillsGroup.endpoints),
      ].sort(),
    ).toEqual(TENANCY_API_ROUTES.map((route) => route.name).sort());
  });

  test("publishes definitions into immutable releases and manages deployments", async () => {
    const fixture = createTenancyContractFixture();
    const api = client(fixture.fetch, fixture.adminToken);
    const organization = await api("POST", "/v1/organizations", {
      idem: "agents-org",
      body: { name: "Agent Platform" },
    });
    const organizationId = stringField(organization.body, "id");
    const project = await api("POST", "/v1/projects", {
      idem: "agents-project",
      scope: { "x-deployments-organization": organizationId },
      body: { name: "Control Plane" },
    });
    const projectId = stringField(project.body, "id");
    const environment = await api("POST", "/v1/environments", {
      idem: "agents-environment",
      scope: { "x-deployments-project": projectId },
      body: { name: "Development", type: "development" },
    });
    const environmentId = stringField(environment.body, "id");
    const environmentScope = { "x-deployments-environment": environmentId };
    const oversizedDraft = await api("POST", "/v1/agent-definitions", {
      idem: "oversized-definition",
      scope: environmentScope,
      body: {
        manifest: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "Agent",
          metadata: { key: "oversized.agent", name: "Oversized Agent", version: "1.0.0" },
          spec: {
            capabilities: {
              tools: [{ name: "records.read", required: false, requiredScopes: [] }],
            },
            instructions: "Reject this draft before persistence.",
            model: { id: "openrouter/default" },
            runtime: {
              toolRequests: [
                {
                  effect: "read",
                  idempotencyKey: "oversized-input",
                  input: { value: "x".repeat(33 * 1_024) },
                  inputSummary: "Oversized input",
                  requiredScopes: [],
                  toolName: "records.read",
                },
              ],
            },
            sandbox: { mode: "none" },
          },
        },
      },
    });
    expect(oversizedDraft.body).toMatchObject({ code: "validation_failed", status: 422 });
    let deeplyNestedInput: Record<string, unknown> = { value: "leaf" };
    for (let depth = 0; depth < 32; depth += 1) deeplyNestedInput = { value: deeplyNestedInput };
    const deeplyNestedDraft = await api("POST", "/v1/agent-definitions", {
      idem: "deeply-nested-definition",
      scope: environmentScope,
      body: {
        manifest: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "Agent",
          metadata: { key: "nested.agent", name: "Nested Agent", version: "1.0.0" },
          spec: {
            capabilities: {
              tools: [{ name: "records.read", required: false, requiredScopes: [] }],
            },
            instructions: "Reject deeply nested input before recursive schema decoding.",
            model: { id: "openrouter/default" },
            runtime: {
              toolRequests: [
                {
                  effect: "read",
                  idempotencyKey: "deeply-nested-input",
                  input: deeplyNestedInput,
                  inputSummary: "Deeply nested input",
                  requiredScopes: [],
                  toolName: "records.read",
                },
              ],
            },
            sandbox: { mode: "none" },
          },
        },
      },
    });
    expect(deeplyNestedDraft.body).toMatchObject({ code: "validation_failed", status: 422 });
    const manifest = {
      apiVersion: "agents.deployments.ai/v1",
      kind: "Agent",
      metadata: {
        key: "operations.assistant",
        name: "Operations Assistant",
        version: "1.0.0",
      },
      spec: {
        capabilities: {
          tools: [
            {
              authorization: "workspace",
              name: "records.read",
              required: true,
              requiredScopes: [],
            },
          ],
        },
        instructions: "Complete the requested operation.",
        model: { id: "openrouter/default" },
        sandbox: { mode: "none" },
        triggers: ["api"],
      },
    };

    const definition = await api("POST", "/v1/agent-definitions", {
      idem: "definition-create",
      scope: environmentScope,
      body: { manifest },
    });
    expect(definition.response.status).toBe(201);
    expect(definition.body).toMatchObject({
      name: "Operations Assistant",
      slug: "operations.assistant",
      status: "active",
      version: 0,
    });
    const definitionId = stringField(definition.body, "id");
    const updatedManifest = {
      ...manifest,
      metadata: { ...manifest.metadata, version: "1.1.0" },
      spec: { ...manifest.spec, instructions: "Complete the request and report the result." },
    };
    const updated = await api("PATCH", `/v1/agent-definitions/${definitionId}`, {
      idem: "definition-update",
      scope: environmentScope,
      body: { expectedVersion: 0, manifest: updatedManifest },
    });
    expect(updated.body).toMatchObject({ version: 1, draft: { metadata: { version: "1.1.0" } } });
    expect(
      (
        await api("POST", `/v1/agent-definitions/${definitionId}/releases`, {
          idem: "stale-publish",
          scope: environmentScope,
          body: { expectedDefinitionVersion: 0 },
        })
      ).body,
    ).toMatchObject({ code: "version_conflict", status: 409 });

    const release = await api("POST", `/v1/agent-definitions/${definitionId}/releases`, {
      idem: "release-publish",
      scope: environmentScope,
      body: { expectedDefinitionVersion: 1 },
    });
    expect(release.response.status).toBe(201);
    expect(release.body).toMatchObject({
      agentDefinitionId: definitionId,
      manifest: { metadata: { version: "1.1.0" } },
      releaseNumber: 1,
      status: "active",
      version: 0,
    });
    expect(stringField(release.body, "contentHash")).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const releaseId = stringField(release.body, "id");
    expect(
      (
        await api("POST", `/v1/agent-definitions/${definitionId}/releases`, {
          idem: "concurrent-publish",
          scope: environmentScope,
          body: { expectedDefinitionVersion: 1 },
        })
      ).body,
    ).toMatchObject({ code: "version_conflict", status: 409 });
    expect(
      (
        await api("GET", `/v1/agent-definitions/${definitionId}/releases`, {
          scope: environmentScope,
        })
      ).body,
    ).toMatchObject({ items: [{ id: releaseId }] });
    const listedDefinitions = await api("GET", "/v1/agent-definitions", {
      scope: environmentScope,
    });
    expect(
      (listedDefinitions.body as { items: readonly Record<string, unknown>[] }).items[0],
    ).not.toHaveProperty("draft");
    const listedReleases = await api("GET", `/v1/agent-definitions/${definitionId}/releases`, {
      scope: environmentScope,
    });
    expect(
      (listedReleases.body as { items: readonly Record<string, unknown>[] }).items[0],
    ).not.toHaveProperty("manifest");

    const invalidDeployment = await api("POST", "/v1/agent-deployments", {
      idem: "invalid-deployment",
      scope: environmentScope,
      body: {
        agentReleaseId: releaseId,
        runtimeConfig: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "AgentDeploymentConfig",
          toolAuthorizations: {
            "undeclared.read": { authorizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
          },
        },
      },
    });
    expect(invalidDeployment.body).toMatchObject({
      code: "invalid_agent_deployment_config",
      status: 422,
    });
    expect(
      (
        await api("POST", "/v1/agent-deployments", {
          idem: "missing-deployment-binding",
          scope: environmentScope,
          body: { agentReleaseId: releaseId },
        })
      ).body,
    ).toMatchObject({ code: "invalid_agent_deployment_config", status: 422 });

    const deployment = await api("POST", "/v1/agent-deployments", {
      idem: "deployment-create",
      scope: environmentScope,
      body: {
        agentReleaseId: releaseId,
        runtimeConfig: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "AgentDeploymentConfig",
          toolAuthorizations: {
            "records.read": { authorizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
          },
        },
      },
    });
    expect(deployment.response.status).toBe(201);
    expect(deployment.body).toMatchObject({
      agentDefinitionId: definitionId,
      agentReleaseId: releaseId,
      currentState: "ready",
      desiredState: "running",
      version: 0,
    });
    const deploymentId = stringField(deployment.body, "id");
    const paused = await api("PATCH", `/v1/agent-deployments/${deploymentId}`, {
      idem: "deployment-pause",
      scope: environmentScope,
      body: { desiredState: "paused", expectedVersion: 0 },
    });
    expect(paused.body).toMatchObject({
      currentState: "paused",
      desiredState: "paused",
      version: 1,
    });
    expect(
      (
        await api("DELETE", `/v1/agent-releases/${releaseId}`, {
          idem: "release-archive-blocked",
          scope: environmentScope,
          body: { expectedVersion: 0 },
        })
      ).body,
    ).toMatchObject({ code: "release_in_use", status: 409 });
    const stopped = await api("DELETE", `/v1/agent-deployments/${deploymentId}`, {
      idem: "deployment-stop",
      scope: environmentScope,
      body: { expectedVersion: 1 },
    });
    expect(stopped.body).toMatchObject({
      currentState: "stopped",
      desiredState: "stopped",
      version: 2,
    });
    const archivedRelease = await api("DELETE", `/v1/agent-releases/${releaseId}`, {
      idem: "release-archive",
      scope: environmentScope,
      body: { expectedVersion: 0 },
    });
    expect(archivedRelease.body).toMatchObject({ status: "archived", version: 1 });
    expect(
      (
        await api("PATCH", `/v1/agent-deployments/${deploymentId}`, {
          idem: "deployment-restart-stopped",
          scope: environmentScope,
          body: { desiredState: "running", expectedVersion: 2 },
        })
      ).body,
    ).toMatchObject({ code: "deployment_stopped", status: 409 });
    const archivedDefinition = await api("DELETE", `/v1/agent-definitions/${definitionId}`, {
      idem: "definition-archive",
      scope: environmentScope,
      body: { expectedVersion: 2 },
    });
    expect(archivedDefinition.body).toMatchObject({ status: "archived", version: 3 });
  });

  test("publishes health and the generated OpenAPI document", async () => {
    const fixture = createTenancyContractFixture();
    expect((await client(fixture.fetch, "none")("GET", "/health")).response.status).toBe(200);
    const openapi = await client(fixture.fetch, "none")("GET", "/v1/openapi.json");
    expect(openapi.body.openapi).toBe("3.1.0");
    expect(openapi.response.headers.get("x-request-id")).toBeTruthy();
  });

  test("exercises organization, project, environment, service-account, and API-key lifecycle", async () => {
    const fixture = createTenancyContractFixture();
    const api = client(fixture.fetch, fixture.adminToken);
    const org = await api("POST", "/v1/organizations", {
      idem: "org-create",
      body: { name: "Acme" },
    });
    expect(org.response.status).toBe(201);
    const organizationId = stringField(org.body, "id");
    const orgScope = { "x-deployments-organization": organizationId };
    const replay = await api("POST", "/v1/organizations", {
      idem: "org-create",
      body: { name: "Acme" },
    });
    expect(replay.body.id).toBe(organizationId);
    const project = await api("POST", "/v1/projects", {
      idem: "project-create",
      scope: orgScope,
      body: { name: "Platform" },
    });
    const projectId = stringField(project.body, "id");
    const projectScope = { "x-deployments-project": projectId };
    const environment = await api("POST", "/v1/environments", {
      idem: "env-create",
      scope: projectScope,
      body: { name: "Production", type: "production" },
    });
    const environmentId = stringField(environment.body, "id");
    const environmentScope = { "x-deployments-environment": environmentId };
    const account = await api("POST", "/v1/service-accounts", {
      idem: "sa-create",
      scope: environmentScope,
      body: { name: "Worker", scopes: ["projects:read", "api-keys:read"] },
    });
    const issued = await api("POST", "/v1/api-keys", {
      idem: "key-create",
      scope: environmentScope,
      body: { name: "Worker key", serviceAccountId: stringField(account.body, "id") },
    });
    expect(issued.body.secretVisibleOnce).toBe(true);
    expect(issued.body).not.toHaveProperty("credentialHash");
    const issuedId = stringField(issued.body, "id");
    const issuedSecret = stringField(issued.body, "secret");

    expect((await api("GET", "/v1/organizations")).response.status).toBe(200);
    expect(
      (await api("GET", `/v1/organizations/${organizationId}`, { scope: orgScope })).response
        .status,
    ).toBe(200);
    expect(
      (
        await api("PATCH", `/v1/organizations/${organizationId}`, {
          idem: "org-update",
          scope: orgScope,
          body: { name: "Acme Inc" },
        })
      ).body.name,
    ).toBe("Acme Inc");
    expect((await api("GET", "/v1/projects", { scope: orgScope })).response.status).toBe(200);
    expect(
      (await api("GET", `/v1/projects/${projectId}`, { scope: projectScope })).response.status,
    ).toBe(200);
    expect(
      (
        await api("PATCH", `/v1/projects/${projectId}`, {
          idem: "project-update",
          scope: projectScope,
          body: { name: "Platform Core" },
        })
      ).body.name,
    ).toBe("Platform Core");
    expect((await api("GET", "/v1/environments", { scope: projectScope })).response.status).toBe(
      200,
    );
    expect(
      (await api("GET", `/v1/environments/${environmentId}`, { scope: environmentScope })).response
        .status,
    ).toBe(200);
    expect(
      (
        await api("PATCH", `/v1/environments/${environmentId}`, {
          idem: "environment-update",
          scope: environmentScope,
          body: { name: "Production US" },
        })
      ).body.name,
    ).toBe("Production US");
    expect(
      (await api("GET", "/v1/service-accounts", { scope: environmentScope })).response.status,
    ).toBe(200);
    const accountId = stringField(account.body, "id");
    expect(
      (await api("GET", `/v1/service-accounts/${accountId}`, { scope: environmentScope })).response
        .status,
    ).toBe(200);

    const machine = client(fixture.fetch, issuedSecret);
    expect(
      (await machine("GET", "/v1/api-keys", { scope: environmentScope })).response.status,
    ).toBe(200);
    expect(
      (
        await machine("GET", "/v1/projects", {
          scope: { "x-deployments-organization": "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        })
      ).response.status,
    ).toBe(403);
    const rotated = await api("POST", `/v1/api-keys/${issuedId}/rotate`, {
      idem: "key-rotate",
      scope: environmentScope,
    });
    expect(stringField(rotated.body, "secret")).not.toBe(issuedSecret);
    expect(
      (await machine("GET", "/v1/api-keys", { scope: environmentScope })).response.status,
    ).toBe(401);
    const revoked = await api("DELETE", `/v1/api-keys/${issuedId}`, {
      idem: "key-revoke",
      scope: environmentScope,
    });
    expect(revoked.body.status).toBe("revoked");
    expect(
      (
        await api("DELETE", `/v1/service-accounts/${accountId}`, {
          idem: "service-account-revoke",
          scope: environmentScope,
        })
      ).body.status,
    ).toBe("disabled");
    expect(
      (
        await api("DELETE", `/v1/environments/${environmentId}`, {
          idem: "environment-archive",
          scope: environmentScope,
        })
      ).body.status,
    ).toBe("archived");
    expect(
      (
        await api("DELETE", `/v1/projects/${projectId}`, {
          idem: "project-archive",
          scope: projectScope,
        })
      ).body.status,
    ).toBe("archived");
  });

  test("returns RFC 9457 errors for auth, scope, validation, and idempotency conflicts", async () => {
    const fixture = createTenancyContractFixture();
    const unauthenticated = await client(fixture.fetch, "bad")("GET", "/v1/organizations");
    expect(unauthenticated.response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(unauthenticated.body).toMatchObject({ status: 401, code: "unauthorized" });
    const api = client(fixture.fetch, fixture.adminToken);
    expect((await api("GET", "/v1/projects")).body.code).toBe("missing_scope");
    expect(
      (await api("POST", "/v1/organizations", { idem: "invalid", body: { name: "" } })).body.code,
    ).toBe("validation_failed");
    await api("POST", "/v1/organizations", { idem: "same", body: { name: "One" } });
    expect(
      (await api("POST", "/v1/organizations", { idem: "same", body: { name: "Two" } })).body.code,
    ).toBe("idempotency_conflict");
  });

  test("returns request-scoped problems for malformed JSON and unknown routes", async () => {
    const fixture = createTenancyContractFixture();
    const malformed = await fixture.fetch(
      new Request(`${base}/v1/organizations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.adminToken}`,
          "content-type": "application/json",
          "idempotency-key": "malformed",
        },
        body: "{",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toContain("application/problem+json");
    expect(malformed.headers.get("x-request-id")).toBeTruthy();
    expect(await malformed.json()).toMatchObject({ status: 400, code: "invalid_json" });

    const missing = await client(fixture.fetch, fixture.adminToken)("GET", "/v1/not-found");
    expect(missing.response.status).toBe(404);
    expect(missing.response.headers.get("x-request-id")).toBeTruthy();
    expect(missing.body).toMatchObject({ status: 404, code: "route_not_found" });
  });
});
