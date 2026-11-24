import { describe, expect, test } from "bun:test";
import { AGENT_EMAIL_API_ROUTES } from "./agent-email.ts";
import { APPS_API_ROUTES } from "./apps-routes.ts";
import { EGRESS_ALLOWLIST_API_ROUTES } from "./egress-allowlist.ts";
import { EMAIL_API_ROUTES } from "./email.ts";
import { BRAIN_API_ROUTES } from "./brains.ts";
import { GOVERNANCE_API_ROUTES } from "./governance.ts";
import { IDENTITY_API_ROUTES } from "./identity.ts";
import { IDENTITY_FEDERATION_API_ROUTES } from "./identity-federation.ts";
import { DIRECTORY_API_ROUTES } from "./directory.ts";
import { MEMORY_API_ROUTES } from "./memory.ts";
import { OPERATIONS_API_ROUTES } from "./operations.ts";
import { OBSERVABILITY_API_ROUTES } from "./observability.ts";
import { MODEL_API_ROUTES } from "./model-routes.ts";
import { MODEL_CREDENTIAL_API_ROUTES } from "./model-credentials.ts";
import { ORGANIZATION_SPEND_API_ROUTES } from "./organization-spend.ts";
import { EVALUATION_API_ROUTES } from "./evaluation-routes.ts";
import { PROVIDER_API_ROUTES } from "./providers.ts";
import type { PublicRouteName } from "./product.ts";
import { PUBLIC_API_ROUTES, PUBLIC_ROUTE_BY_NAME, publicRouteContract } from "./product.ts";
import { RUNTIME_API_ROUTES, STREAM_GATEWAY_API_ROUTES } from "./runtime.ts";
import { PUBLIC_API_SCHEMAS } from "./schema-registry.ts";
import { TENANCY_API_ROUTES } from "./routes.ts";
import { makePublicOpenApiSpec } from "./openapi.ts";
import { SYSTEM_API_ROUTES } from "./system.ts";
import { TOOLING_API_ROUTES } from "./tooling.ts";
import { CREDENTIAL_REFERENCE_API_ROUTES } from "./credential-references.ts";
import { BUDGET_API_ROUTES } from "./budgets.ts";
import { MONITOR_API_ROUTES } from "./monitors.ts";
import { TOOL_CATALOG_API_ROUTES } from "./tool-catalog.ts";
import { WORKSPACE_SPEND_API_ROUTES } from "./workspace-spend.ts";

type PublicRouteNamesAreWide = string extends PublicRouteName ? true : false;
const publicRouteNamesAreWide: PublicRouteNamesAreWide = false;

const publicOpenApiSpec = makePublicOpenApiSpec();

function operation(method: string, path: string) {
  const openApiPath = path.replaceAll(/:([A-Za-z0-9_]+)/gu, "{$1}");
  return publicOpenApiSpec.paths[openApiPath]?.[method.toLowerCase()];
}

describe("public product API contract", () => {
  test("composes every public product operation", () => {
    expect(PUBLIC_API_ROUTES).toHaveLength(
      TENANCY_API_ROUTES.length +
        BRAIN_API_ROUTES.length +
        AGENT_EMAIL_API_ROUTES.length +
        EMAIL_API_ROUTES.length +
        APPS_API_ROUTES.length +
        RUNTIME_API_ROUTES.length +
        STREAM_GATEWAY_API_ROUTES.length +
        IDENTITY_API_ROUTES.length +
        IDENTITY_FEDERATION_API_ROUTES.length +
        DIRECTORY_API_ROUTES.length +
        MEMORY_API_ROUTES.length +
        OPERATIONS_API_ROUTES.length +
        OBSERVABILITY_API_ROUTES.length +
        EVALUATION_API_ROUTES.length +
        PROVIDER_API_ROUTES.length +
        TOOLING_API_ROUTES.length +
        CREDENTIAL_REFERENCE_API_ROUTES.length +
        BUDGET_API_ROUTES.length +
        TOOL_CATALOG_API_ROUTES.length +
        MODEL_API_ROUTES.length +
        MODEL_CREDENTIAL_API_ROUTES.length +
        EGRESS_ALLOWLIST_API_ROUTES.length +
        ORGANIZATION_SPEND_API_ROUTES.length +
        WORKSPACE_SPEND_API_ROUTES.length +
        GOVERNANCE_API_ROUTES.length +
        SYSTEM_API_ROUTES.length +
        MONITOR_API_ROUTES.length,
    );

    const names = PUBLIC_API_ROUTES.map((route) => route.name);
    const methodPaths = PUBLIC_API_ROUTES.map(
      (route) => `${route.method} ${route.path.replaceAll(/:[^/]+/gu, "{}")}`,
    );
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(methodPaths).size).toBe(methodPaths.length);
    expect(publicRouteNamesAreWide).toBe(false);
    expect(Object.keys(PUBLIC_ROUTE_BY_NAME)).toHaveLength(PUBLIC_API_ROUTES.length);
    expect(publicRouteContract("submitAgentRun").path).toBe(
      "/v1/agent-deployments/:agentDeploymentId/runs",
    );
    expect(publicRouteContract("listRuns").path).toBe("/v1/runs");
    expect(publicRouteContract("listThreads").path).toBe("/v1/threads");
    expect(publicRouteContract("listApprovals").path).toBe("/v1/approvals");
    expect(publicRouteContract("listWebhooks").path).toBe("/v1/webhooks");
    expect(publicRouteContract("createConnectionGrant").path).toBe("/v1/connection-grants");
    expect(publicRouteContract("createExtensionTool").path).toBe("/v1/extensions");
  });

  test("backs every JSON operation with registered request and response schemas", () => {
    for (const route of PUBLIC_API_ROUTES) {
      expect(PUBLIC_API_SCHEMAS).toHaveProperty(route.responseBody);
      if ("requestBody" in route && route.requestBody) {
        expect(PUBLIC_API_SCHEMAS).toHaveProperty(route.requestBody);
      }
      expect(operation(route.method, route.path)?.operationId).toBe(route.name);
    }
  });

  test("resolves every OpenAPI component schema reference", () => {
    const componentNames = new Set(Object.keys(publicOpenApiSpec.components.schemas));
    const referencedNames = [
      ...JSON.stringify(publicOpenApiSpec).matchAll(/#\/components\/schemas\/([^"\\]+)/gu),
    ].map((match) => match[1] ?? "");

    expect(referencedNames.length).toBeGreaterThan(0);
    expect(referencedNames.filter((name) => !componentNames.has(name))).toEqual([]);
  });

  test("publishes one phase-free OpenAPI document with truthful security boundaries", () => {
    expect(publicOpenApiSpec.openapi).toBe("3.1.0");
    expect(publicOpenApiSpec.info).toEqual({
      title: "Deployments.ai Public API",
      version: "1.0.0",
    });
    expect(publicOpenApiSpec.tags).toContainEqual({ name: "Agent Email" });
    expect(publicOpenApiSpec.tags).toContainEqual({ name: "Brains" });
    expect(publicOpenApiSpec.tags).toContainEqual({ name: "Observability" });
    expect(publicOpenApiSpec.tags).toContainEqual({ name: "Models" });
    expect(JSON.stringify(publicOpenApiSpec)).not.toContain("phase-2");

    expect(operation("POST", "/v1/agent-definitions")?.security).toEqual([{ platformBearer: [] }]);
    const runtimeSecurity = [{ apiCredentialBearer: [] }, { platformBearer: [] }];
    expect(operation("POST", "/v1/agent-deployments/:agentDeploymentId/runs")?.security).toEqual(
      runtimeSecurity,
    );
    expect(operation("GET", "/v1/threads/:threadId/stream")?.security).toEqual([
      { streamSessionBearer: [] },
    ]);
    expect(operation("POST", "/v1/runs/:runId/replay")?.security).toEqual(runtimeSecurity);
    expect(operation("POST", "/v1/webhooks")?.security).toEqual(runtimeSecurity);
    for (const route of RUNTIME_API_ROUTES) {
      expect(operation(route.method, route.path)?.security).toEqual(runtimeSecurity);
    }
    expect(operation("POST", "/v1/memory/search")?.security).toEqual([{ tenantJwt: [] }]);
    expect(operation("POST", "/v1/brains")?.security).toEqual([{ tenantJwt: [] }]);
    expect(operation("GET", "/v1/usage")?.security).toEqual([{ platformBearer: [] }]);
    expect(operation("GET", "/v1/whoami")?.security).toEqual([{ platformBearer: [] }]);
    expect(operation("POST", "/v1/agent-email/inboxes")?.security).toEqual([
      { platformBearer: [] },
    ]);
    expect(operation("GET", "/health")?.security).toEqual([]);
  });

  test("omits agent-email discovery when its gateway integration is disabled", () => {
    const spec = makePublicOpenApiSpec({ includeAgentEmail: false });
    expect(spec.tags).not.toContainEqual({ name: "Agent Email" });
    expect(spec.paths).not.toHaveProperty("/v1/agent-email/inboxes");
    expect(spec.paths).toHaveProperty("/v1/organizations");
  });

  test("describes service-specific authorization and streaming semantics", () => {
    expect(operation("POST", "/v1/memory/search")?.description).toContain("memory:read");
    expect(
      operation("POST", "/v1/agent-deployments/:agentDeploymentId/runs")?.description,
    ).toContain("runs:write");
    expect(operation("GET", "/v1/approvals")?.description).toContain("approvals:read");
    expect(operation("POST", "/v1/webhooks")?.description).toContain("webhooks:write");
    expect(operation("GET", "/v1/models")?.description).toContain("models:read");
    expect(operation("DELETE", "/v1/model-policies/:id")?.description).toContain("models:write");
    expect(operation("GET", "/v1/models")?.parameters).toContainEqual(
      expect.objectContaining({
        in: "query",
        name: "provider",
        schema: { enum: ["bedrock", "openai", "openrouter"], type: "string" },
      }),
    );
    expect(operation("POST", "/v1/brains/search")?.parameters).toEqual(
      expect.arrayContaining(
        ["organization", "project", "environment"].map((scope) =>
          expect.objectContaining({
            name: `x-deployments-${scope}`,
            required: true,
          }),
        ),
      ),
    );
    const streamRead = operation("GET", "/v1/threads/:threadId/stream");
    expect(streamRead?.responses).toMatchObject({
      200: {
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/RuntimeStreamResponse" } },
          "text/event-stream": {},
        },
      },
    });
    expect(streamRead).toMatchObject({ servers: [{ url: "{streamGatewayOrigin}" }] });
    expect(operation("GET", "/v1/threads/:threadId/messages")).not.toHaveProperty("servers");
    expect(operation("POST", "/v1/agent-definitions")?.parameters).toContainEqual(
      expect.objectContaining({
        name: "idempotency-key",
        schema: expect.objectContaining({ maxLength: 512 }),
      }),
    );
    expect(
      operation("POST", "/v1/agent-deployments/:agentDeploymentId/runs")?.parameters,
    ).toContainEqual(
      expect.objectContaining({
        description: expect.stringContaining("no surrounding whitespace or control characters"),
        name: "idempotency-key",
        schema: expect.objectContaining({
          maxLength: 256,
          pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000-\\u001F\\u007F]+$",
        }),
      }),
    );
    expect(operation("POST", "/v1/runs/:runId/replay")?.parameters).toContainEqual(
      expect.objectContaining({
        name: "idempotency-key",
        required: true,
      }),
    );
    expect(operation("POST", "/v1/threads")?.parameters).not.toContainEqual(
      expect.objectContaining({ name: "idempotency-key" }),
    );
    expect(operation("POST", "/v1/webhooks")?.parameters).not.toContainEqual(
      expect.objectContaining({ name: "idempotency-key" }),
    );
    expect(operation("POST", "/v1/memory/imports")?.parameters).toContainEqual(
      expect.objectContaining({
        in: "header",
        name: "idempotency-key",
        required: false,
        schema: expect.objectContaining({ maxLength: 500 }),
      }),
    );
  });
});
