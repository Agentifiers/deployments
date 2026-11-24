import { describe, expect, test } from "bun:test";
import { AGENT_TOOL_NAME_PATTERN_SOURCE } from "@deployments-ai/agent-manifest/schema";
import { Schema } from "effect";
import {
  ApiCredentialResponse,
  CreateEnvironmentRequest,
  CreateProjectRequest,
  ListEnvironmentsResponse,
  ListQuery,
  PublicId,
  ProblemDetails,
  TENANCY_API_ROUTES,
  TENANCY_API_SCHEMAS,
  TENANCY_LIST_PATHS,
  TENANCY_PATHS,
  UpdateEnvironmentRequest,
  agentReleaseResponse,
  apiCredentialResponse,
  decodeTenancyIdempotencyKey,
  decodeTenancyRequest,
  decodeTenancyQuery,
  environmentResponse,
  issuedApiCredentialResponse,
  makeTenancyOpenApiSpec,
  organizationResponse,
  resolveSlug,
} from "./index.ts";

const ORG_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const RESOURCE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const NOW = "2026-07-21T00:00:00.000Z";

describe("tenancy API contract", () => {
  test("normalizes or derives canonical slugs", () => {
    expect(String(resolveSlug({ name: "Production API" }))).toBe("production-api");
    expect(String(resolveSlug({ name: "Ignored", slug: "  Customer_Success  " }))).toBe(
      "customer-success",
    );
    expect(() => resolveSlug({ name: "---" })).toThrow("Slugs must be");
  });

  test("rejects public IDs outside the canonical 128-bit ULID range", () => {
    expect(() => Schema.decodeUnknownSync(PublicId)("ZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toThrow();
    expect(String(Schema.decodeUnknownSync(PublicId)(ORG_ID))).toBe(ORG_ID);
  });

  test("uses type as the public environment field", () => {
    const request = Schema.decodeUnknownSync(CreateEnvironmentRequest)({
      name: "Production",
      type: "production",
    });

    expect(request.type).toBe("production");
    expect(request).not.toHaveProperty("kind");
  });

  test("keeps unpersisted descriptions out of project and environment contracts", () => {
    const request = Schema.decodeUnknownSync(CreateProjectRequest)({
      name: "Platform",
      slug: "platform",
    });

    expect(request).not.toHaveProperty("description");
    expect(() =>
      decodeTenancyRequest("createProject", {
        description: "Not persisted yet.",
        name: "Platform",
      }),
    ).toThrow();
  });

  test("rejects empty mutation requests", () => {
    expect(() => Schema.decodeUnknownSync(UpdateEnvironmentRequest)({})).toThrow(
      "must change one field",
    );
  });

  test("rejects resource versions beyond safe integer precision", () => {
    expect(() =>
      decodeTenancyRequest("publishAgentRelease", {
        expectedDefinitionVersion: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });

  test("validates agent release hash format and manifest semantics", () => {
    const manifest = {
      apiVersion: "agents.deployments.ai/v1",
      kind: "Agent",
      metadata: { key: "contract.agent", name: "Contract Agent", version: "1.0.0" },
      spec: {
        instructions: "Validate the release contract.",
        model: { id: "openrouter/default" },
        sandbox: { mode: "none" },
      },
    };
    const release = {
      agentDefinitionId: RESOURCE_ID,
      contentHash: `sha256:${"0".repeat(64)}`,
      createdAt: NOW,
      createdByPrincipalId: ORG_ID,
      environmentId: ENVIRONMENT_ID,
      id: PROJECT_ID,
      manifest,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      releaseNumber: 1,
      status: "active",
      version: 0,
    };
    expect(() => agentReleaseResponse({ ...release, contentHash: "sha256:invalid" })).toThrow();
    expect(() =>
      agentReleaseResponse({
        ...release,
        manifest: {
          ...manifest,
          spec: {
            ...manifest.spec,
            runtime: {
              toolRequests: [
                {
                  effect: "read",
                  idempotencyKey: "missing-tool",
                  inputSummary: "Call an undeclared tool.",
                  requiredScopes: [],
                  toolName: "missing.tool",
                },
              ],
            },
          },
        },
      }),
    ).toThrow("not declared as a capability");
  });

  test("validates the workspace of a new agent definition", () => {
    const manifest = {
      apiVersion: "agents.deployments.ai/v1",
      kind: "Agent",
      metadata: { key: "contract.agent", name: "Contract Agent", version: "1.0.0" },
      spec: {
        instructions: "Answer questions.",
        model: { id: "openrouter/default" },
        sandbox: { mode: "none" },
      },
    };
    expect(
      decodeTenancyRequest("createAgentDefinition", { manifest, workspaceId: RESOURCE_ID }),
    ).toEqual({ manifest, workspaceId: RESOURCE_ID });
    expect(() =>
      decodeTenancyRequest("createAgentDefinition", { manifest, workspaceId: "workspace-1" }),
    ).toThrow();
    expect(() =>
      decodeTenancyRequest("createAgentDefinition", { manifest, workspace: RESOURCE_ID }),
    ).toThrow();
  });

  test("accepts omitted bodies only for routes that declare them optional", () => {
    expect(decodeTenancyRequest("archiveProject", undefined)).toEqual({});
    expect(decodeTenancyRequest("revokeServiceAccount", undefined)).toEqual({});
    expect(decodeTenancyRequest("rotateApiCredential", undefined)).toEqual({});
    expect(() => decodeTenancyRequest("createProject", undefined)).toThrow();
  });

  test("requires idempotency keys only on declared mutation routes", () => {
    expect(decodeTenancyIdempotencyKey("createProject", "idem_project_create")).toBe(
      "idem_project_create",
    );
    expect(() => decodeTenancyIdempotencyKey("createProject", undefined)).toThrow();
    expect(() => decodeTenancyIdempotencyKey("getProject", "idem_read")).toThrow();
  });

  test("requires at least one service-account scope", () => {
    expect(() =>
      decodeTenancyRequest("createServiceAccount", { name: "Worker", scopes: [] }),
    ).toThrow("at least one scope");
  });

  test("projects private environment kind without leaking DynamoDB fields", () => {
    const response = environmentResponse({
      createdAt: NOW,
      gsi1pk: `ORG#${ORG_ID}`,
      id: ENVIRONMENT_ID,
      kind: "production",
      name: "Production",
      organizationId: ORG_ID,
      pk: `ORG#${ORG_ID}#PROJECT#${PROJECT_ID}`,
      projectId: PROJECT_ID,
      sk: `ENVIRONMENT#${ENVIRONMENT_ID}`,
      slug: "production",
      status: "active",
      updatedAt: NOW,
      version: 1,
    });

    expect(response.type).toBe("production");
    expect(response).not.toHaveProperty("kind");
    expect(response).not.toHaveProperty("pk");
    expect(response).not.toHaveProperty("sk");
    expect(response).not.toHaveProperty("gsi1pk");
  });

  test("whitelists organization response fields", () => {
    const response = organizationResponse({
      createdAt: NOW,
      credentialHash: "sha256:must-not-leak",
      id: ORG_ID,
      name: "Deployments.ai",
      pk: `ORG#${ORG_ID}`,
      secretRef: { arn: "must-not-leak" },
      slug: "deployments-ai",
      status: "active",
      updatedAt: NOW,
      version: 1,
    });

    expect(response).not.toHaveProperty("credentialHash");
    expect(response).not.toHaveProperty("pk");
    expect(response).not.toHaveProperty("secretRef");
  });

  test("never returns credential hashes or references", () => {
    const stored = {
      createdAt: NOW,
      credentialHash: "sha256:must-not-leak",
      credentialRef: { arn: "must-not-leak" },
      environmentId: ENVIRONMENT_ID,
      id: RESOURCE_ID,
      keyPrefix: "dpl_live_abc",
      name: "Fixture key",
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      scopes: ["runs:read"],
      serviceAccountId: RESOURCE_ID,
      status: "active",
      updatedAt: NOW,
      version: 1,
    };

    const response = apiCredentialResponse(stored);
    const issued = issuedApiCredentialResponse(stored, "dpl_live_secret");

    expect(Schema.decodeUnknownSync(ApiCredentialResponse)(response)).toEqual(response);
    expect(response).not.toHaveProperty("credentialHash");
    expect(response).not.toHaveProperty("credentialRef");
    expect(issued.secret).toBe("dpl_live_secret");
    expect(issued.secretVisibleOnce).toBe(true);
  });

  test("bounds pagination and provides RFC 9457-compatible errors", () => {
    expect(Schema.decodeUnknownSync(ListQuery)({ limit: 100 })).toEqual({ limit: 100 });
    expect(() => Schema.decodeUnknownSync(ListQuery)({ limit: 101 })).toThrow(
      "must not exceed 100",
    );
    expect(decodeTenancyQuery("listProjects", { limit: 25 })).toEqual({ limit: 25 });
    expect(decodeTenancyQuery("listProjects", { limit: "25" })).toEqual({ limit: 25 });
    expect(() => decodeTenancyQuery("listProjects", { bogus: "x" })).toThrow();
    expect(
      Schema.decodeUnknownSync(ProblemDetails)({
        code: "environment_scope_violation",
        detail: "The credential cannot access the requested environment.",
        requestId: "req_123",
        status: 403,
        title: "Environment scope violation",
        type: "https://docs.deployments.ai/errors/environment-scope",
      }),
    ).toMatchObject({ status: 403, code: "environment_scope_violation" });
  });

  test("publishes one unique contract for each tenancy and agent operation", () => {
    const names = TENANCY_API_ROUTES.map((route) => route.name);
    expect(new Set(names).size).toBe(names.length);
    expect(TENANCY_PATHS.environments).toBe("/v1/environments");
    expect(TENANCY_LIST_PATHS).not.toContain(TENANCY_PATHS.agentReleases);
    expect(TENANCY_API_ROUTES.find((route) => route.name === "createApiCredential")).toMatchObject({
      idempotent: true,
      responseBody: "IssuedApiCredentialResponse",
      scope: "environment",
      successStatus: 201,
    });
    expect(TENANCY_API_ROUTES.find((route) => route.name === "getProject")?.errors).toEqual(
      expect.arrayContaining([400, 422]),
    );

    for (const route of TENANCY_API_ROUTES) {
      expect(TENANCY_API_SCHEMAS).toHaveProperty(route.responseBody);
      if ("requestBody" in route && route.requestBody) {
        expect(TENANCY_API_SCHEMAS).toHaveProperty(route.requestBody);
      }
    }
  });

  test("generates a deterministic OpenAPI document from the route and schema registries", () => {
    const tenancyOpenApiSpec = makeTenancyOpenApiSpec();
    const environmentSchema = tenancyOpenApiSpec.components.schemas.EnvironmentResponse as {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    const credentialSchema = tenancyOpenApiSpec.components.schemas.ApiCredentialResponse as {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    const createCredential = tenancyOpenApiSpec.paths["/v1/api-keys"]?.post;
    const rotateCredential = tenancyOpenApiSpec.paths["/v1/api-keys/{id}/rotate"]?.post;
    const updateEnvironment = tenancyOpenApiSpec.components.schemas.UpdateEnvironmentRequest as {
      readonly allOf?: readonly Readonly<Record<string, unknown>>[];
    };
    const createEnvironment = tenancyOpenApiSpec.components.schemas.CreateEnvironmentRequest as {
      readonly properties?: Readonly<Record<string, { readonly anyOf?: readonly unknown[] }>>;
    };
    const createApiCredential = tenancyOpenApiSpec.components.schemas
      .CreateApiCredentialRequest as {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly allOf?: readonly Readonly<Record<string, unknown>>[];
            readonly format?: string;
          }
        >
      >;
    };
    const createAgentDefinition = tenancyOpenApiSpec.components.schemas
      .CreateAgentDefinitionRequest as {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly properties?: Readonly<
              Record<
                string,
                {
                  readonly properties?: Readonly<
                    Record<
                      string,
                      {
                        readonly properties?: Readonly<
                          Record<
                            string,
                            {
                              readonly items?: {
                                readonly properties?: Readonly<Record<string, unknown>>;
                              };
                            }
                          >
                        >;
                      }
                    >
                  >;
                }
              >
            >;
          }
        >
      >;
    };
    const createAgentDeployment = tenancyOpenApiSpec.components.schemas
      .CreateAgentDeploymentRequest as {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly properties?: Readonly<
              Record<
                string,
                {
                  readonly additionalProperties?: boolean;
                  readonly patternProperties?: Readonly<Record<string, unknown>>;
                }
              >
            >;
          }
        >
      >;
    };
    const jsonValueSchema = Object.values(tenancyOpenApiSpec.components.schemas).find(
      (schema) =>
        schema &&
        typeof schema === "object" &&
        (schema as Readonly<Record<string, unknown>>).title === "JsonValue",
    ) as
      | {
          readonly anyOf?: readonly Readonly<Record<string, unknown>>[];
        }
      | undefined;
    const jsonNumberSchema = jsonValueSchema?.anyOf?.find((schema) => schema.type === "number");

    expect(tenancyOpenApiSpec.openapi).toBe("3.1.0");
    expect(environmentSchema.properties).toHaveProperty("type");
    expect(environmentSchema.properties).not.toHaveProperty("kind");
    expect(credentialSchema.properties).not.toHaveProperty("credentialHash");
    expect(createCredential?.operationId).toBe("createApiCredential");
    expect(createCredential?.parameters).toContainEqual(
      expect.objectContaining({ in: "header", name: "idempotency-key", required: true }),
    );
    expect(rotateCredential?.requestBody?.required).toBe(false);
    expect(updateEnvironment.allOf).toContainEqual({ minProperties: 1 });
    expect(createEnvironment.properties?.slug?.anyOf).toBeUndefined();
    expect(createApiCredential.properties?.expiresAt?.format).toBe("date-time");
    expect(createApiCredential.properties?.expiresAt?.allOf).toContainEqual(
      expect.objectContaining({ pattern: expect.stringContaining("\\.\\d{3}Z$") }),
    );
    expect(
      createAgentDefinition.properties?.manifest?.properties?.spec?.properties?.runtime?.properties
        ?.toolRequests?.items?.properties?.input,
    ).toMatchObject({ type: "object" });
    const toolAuthorizations =
      createAgentDeployment.properties?.runtimeConfig?.properties?.toolAuthorizations;
    expect(toolAuthorizations?.additionalProperties).toBe(false);
    expect(Object.keys(toolAuthorizations?.patternProperties ?? {})).toEqual([
      AGENT_TOOL_NAME_PATTERN_SOURCE,
    ]);
    expect(jsonNumberSchema?.allOf).toEqual(
      expect.arrayContaining([
        { maximum: Number.MAX_SAFE_INTEGER },
        { minimum: Number.MIN_SAFE_INTEGER },
      ]),
    );
    expect(() =>
      Schema.decodeUnknownSync(ListEnvironmentsResponse)({ items: [], nextCursor: null }),
    ).not.toThrow();
  });
});
