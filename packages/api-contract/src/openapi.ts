import { Schema } from "effect";
import { AGENT_TOOL_NAME_PATTERN_SOURCE } from "@deployments-ai/agent-manifest/schema";
import { PUBLIC_ID_PATTERN_SOURCE } from "./primitives.ts";
import { PUBLIC_API_ROUTES } from "./product.ts";
import type {
  PublicApiAuthentication,
  PublicApiRouteContract,
  PublicApiStanding,
} from "./route-contract.ts";
import { TENANCY_API_ROUTES, type ApiContextScope, type ApiRouteContract } from "./routes.ts";
import { PUBLIC_API_SCHEMAS, TENANCY_API_SCHEMAS } from "./schema-registry.ts";
import {
  SYSTEM_SERVICE_OPERATION_GRANTS,
  systemServicePath,
  type SystemServiceGrant,
} from "./system-operator.ts";

export const API_CONTRACT_VERSION = 1 as const;

function rewriteSchemaRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteSchemaRefs);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "$ref" && typeof entry === "string"
        ? entry.replace("#/$defs/", "#/components/schemas/")
        : rewriteSchemaRefs(entry),
    ]),
  );
}

function withoutNull(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const object = schema as Readonly<Record<string, unknown>>;
  if (!Array.isArray(object.anyOf)) return schema;

  const anyOf = object.anyOf.filter(
    (candidate) =>
      !candidate ||
      typeof candidate !== "object" ||
      (candidate as Readonly<Record<string, unknown>>).type !== "null",
  );
  if (anyOf.length === 1) return anyOf[0];
  return { ...object, anyOf };
}

function removeOptionalNullability(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeOptionalNullability);
  if (!value || typeof value !== "object") return value;

  const object = value as Readonly<Record<string, unknown>>;
  const required = new Set(Array.isArray(object.required) ? object.required : []);
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => {
      if (key !== "properties" || !entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [key, removeOptionalNullability(entry)];
      }
      return [
        key,
        Object.fromEntries(
          Object.entries(entry).map(([propertyName, propertySchema]) => [
            propertyName,
            removeOptionalNullability(
              required.has(propertyName) || propertyName === "nextCursor"
                ? propertySchema
                : withoutNull(propertySchema),
            ),
          ]),
        ),
      ];
    }),
  );
}

function alignOpenApiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(alignOpenApiSchema);
  if (!value || typeof value !== "object") return value;

  const object = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, alignOpenApiSchema(entry)]),
  );
  const patternProperties = object.patternProperties;
  if (
    patternProperties &&
    typeof patternProperties === "object" &&
    !Array.isArray(patternProperties) &&
    AGENT_TOOL_NAME_PATTERN_SOURCE in patternProperties
  ) {
    return {
      ...object,
      additionalProperties: false,
      patternProperties: {
        [AGENT_TOOL_NAME_PATTERN_SOURCE]: (patternProperties as Readonly<Record<string, unknown>>)[
          AGENT_TOOL_NAME_PATTERN_SOURCE
        ],
      },
    };
  }
  return object;
}

function openApiSchemas(
  registry: Readonly<Record<string, Schema.Top>>,
): Readonly<Record<string, unknown>> {
  const schemas: Record<string, unknown> = {};

  for (const [name, schema] of Object.entries(registry)) {
    const document = Schema.toJsonSchemaDocument(schema);
    for (const [definitionName, definition] of Object.entries(document.definitions)) {
      schemas[definitionName] ??= alignOpenApiSchema(
        removeOptionalNullability(rewriteSchemaRefs(definition)),
      );
    }
    schemas[name] ??= alignOpenApiSchema(
      removeOptionalNullability(rewriteSchemaRefs(document.schema)),
    );
  }

  return schemas;
}

export function tenancyOpenApiSchemas(): Readonly<Record<string, unknown>> {
  return openApiSchemas(TENANCY_API_SCHEMAS);
}

export function publicOpenApiSchemas(): Readonly<Record<string, unknown>> {
  return openApiSchemas(PUBLIC_API_SCHEMAS);
}

function schemaReference(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function openApiPath(path: string) {
  return path.replaceAll(/:([A-Za-z0-9_]+)/gu, "{$1}");
}

function pathParameters(route: Pick<PublicApiRouteContract, "path" | "pathParameters">) {
  const declared = new Map(
    (route.pathParameters ?? []).map((parameter) => [parameter.name, parameter]),
  );
  return Array.from(route.path.matchAll(/:([A-Za-z0-9_]+)/gu), (match) => {
    const name = match[1]!;
    const parameter = declared.get(name);
    return {
      ...(parameter?.description ? { description: parameter.description } : {}),
      in: "path",
      name,
      required: true,
      schema: parameter?.schema ?? {
        pattern: PUBLIC_ID_PATTERN_SOURCE,
        type: "string",
      },
    };
  });
}

const scopeHeaderNames: Readonly<Record<Exclude<ApiContextScope, "none">, string>> = {
  environment: "x-deployments-environment",
  organization: "x-deployments-organization",
  project: "x-deployments-project",
};

function scopeParameter(scope: ApiContextScope) {
  if (scope === "none") return [];
  return [
    {
      in: "header",
      name: scopeHeaderNames[scope],
      required: true,
      schema: {
        pattern: PUBLIC_ID_PATTERN_SOURCE,
        type: "string",
      },
    },
  ];
}

function listParameters(route: ApiRouteContract) {
  if (route.method !== "GET" || !route.name.startsWith("list")) return [];
  return [
    {
      in: "query",
      name: "cursor",
      required: false,
      schema: { maxLength: 4_096, minLength: 1, type: "string" },
    },
    {
      in: "query",
      name: "limit",
      required: false,
      schema: { maximum: 100, minimum: 1, type: "integer" },
    },
  ];
}

function idempotencyParameter(route: ApiRouteContract) {
  if (!route.idempotent) return [];
  return [
    {
      in: "header",
      name: "idempotency-key",
      required: true,
      schema: { maxLength: 512, minLength: 1, type: "string" },
    },
  ];
}

function routeResponses(route: ApiRouteContract) {
  return {
    [route.successStatus]: {
      content: {
        "application/json": {
          schema: schemaReference(route.responseBody),
        },
      },
      description: route.responseBody,
    },
    ...Object.fromEntries(
      route.errors.map((status) => [
        status,
        {
          content: {
            "application/problem+json": {
              schema: schemaReference("ProblemDetails"),
            },
          },
          description: "ProblemDetails",
        },
      ]),
    ),
  };
}

function routeOperation(route: ApiRouteContract) {
  return {
    operationId: route.name,
    parameters: [
      ...pathParameters({ path: route.path }),
      ...scopeParameter(route.scope),
      ...listParameters(route),
      ...idempotencyParameter(route),
    ],
    ...(route.requestBody
      ? {
          requestBody: {
            content: {
              "application/json": {
                schema: schemaReference(route.requestBody),
              },
            },
            required: route.requestBodyRequired ?? true,
          },
        }
      : {}),
    responses: routeResponses(route),
    security: [{ bearerAuth: [] }],
    tags: [route.tag ?? "Tenancy"],
  };
}

export function tenancyOpenApiPaths() {
  const paths: Record<string, Record<string, ReturnType<typeof routeOperation>>> = {};

  for (const route of TENANCY_API_ROUTES) {
    const path = openApiPath(route.path);
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = routeOperation(route);
  }

  return paths;
}

function publicScopeParameters(route: PublicApiRouteContract) {
  const scope = route.scopeHeaders;
  if (scope === "none") return [];
  if (scope === "tenant") {
    return (["organization", "project", "environment"] as const).flatMap(scopeParameter);
  }
  if (scope !== "optional-tenant") return scopeParameter(scope);
  return Object.values(scopeHeaderNames).map((name) => ({
    description:
      route.authentication === "api-credential-or-platform-bearer"
        ? "Required with a platform bearer JWT, where the three tenant headers select an environment the caller can access through active organization membership. Optional with an API key; when supplied, it must match the key's tenant."
        : "Optional tenant consistency assertion; when supplied, it must match the authenticated credential.",
    in: "header",
    name,
    required: false,
    schema: {
      pattern: PUBLIC_ID_PATTERN_SOURCE,
      type: "string",
    },
  }));
}

function publicQueryParameters(route: PublicApiRouteContract) {
  return (route.queryParameters ?? []).map((parameter) => ({
    in: "query",
    name: parameter.name,
    required: parameter.required ?? false,
    schema: parameter.schema,
    ...(parameter.description ? { description: parameter.description } : {}),
  }));
}

function publicIdempotencyParameter(route: PublicApiRouteContract) {
  if (route.idempotency === "none") return [];
  const runtimeKey = route.authentication === "api-credential-or-platform-bearer";
  const maximumLength = runtimeKey ? 256 : route.authentication === "tenant-jwt" ? 500 : 512;
  const description = [
    ...(route.idempotency === "required-or-body"
      ? ["Required unless the request body supplies a stable fireKey."]
      : []),
    ...(runtimeKey
      ? [
          "Must contain 1–256 UTF-8 bytes with no surrounding whitespace or control characters (U+0000–U+001F and U+007F); maxLength is only a character-count approximation.",
        ]
      : route.authentication === "tenant-jwt"
        ? [`Limited to ${maximumLength} UTF-8 bytes.`]
        : []),
  ].join(" ");
  return [
    {
      in: "header",
      name: "idempotency-key",
      required: route.idempotency === "required",
      schema: {
        maxLength: maximumLength,
        minLength: 1,
        ...(runtimeKey ? { pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000-\\u001F\\u007F]+$" } : {}),
        type: "string",
      },
      ...(description ? { description } : {}),
    },
  ];
}

const securityByAuthentication: Readonly<
  Record<PublicApiAuthentication, readonly Readonly<Record<string, readonly never[]>>[]>
> = {
  // Either scheme authenticates the operation (OpenAPI security entries are alternatives).
  "api-credential-or-platform-bearer": [{ apiCredentialBearer: [] }, { platformBearer: [] }],
  none: [],
  "platform-bearer": [{ platformBearer: [] }],
  "stream-session": [{ streamSessionBearer: [] }],
  "tenant-jwt": [{ tenantJwt: [] }],
};

function publicSuccessResponse(route: PublicApiRouteContract) {
  const contentType = route.responseContentType ?? "application/json";
  return {
    content: {
      [contentType]: {
        schema:
          contentType === "application/json"
            ? schemaReference(route.responseBody)
            : { format: "binary", type: "string" },
      },
      ...(route.eventStreamContentType
        ? { [route.eventStreamContentType]: { schema: { type: "string" } } }
        : {}),
    },
    description: route.responseBody,
  };
}

const operationServers: Readonly<
  Record<
    NonNullable<PublicApiRouteContract["server"]>,
    readonly Readonly<Record<string, unknown>>[]
  >
> = {
  "stream-gateway": [
    {
      description:
        "Public stream gateway. Request the absolute streamUrl returned by createThreadStreamSession; its origin is deployment-specific.",
      url: "{streamGatewayOrigin}",
      variables: {
        streamGatewayOrigin: {
          default: "https://streams.us.deployments.ai",
          description: "Origin of the streamUrl returned by createThreadStreamSession.",
        },
      },
    },
  ],
};

function publicRouteResponses(route: PublicApiRouteContract) {
  return {
    [route.successStatus]: publicSuccessResponse(route),
    ...Object.fromEntries(
      route.errors.map((status) => [
        status,
        {
          content: {
            "application/problem+json": {
              schema: schemaReference("ProblemDetails"),
            },
          },
          description: "ProblemDetails",
        },
      ]),
    ),
  };
}

const SERVICE_GRANTS: Readonly<Record<string, SystemServiceGrant>> =
  SYSTEM_SERVICE_OPERATION_GRANTS;

const STANDING_DESCRIPTIONS = {
  distribution: "A suspended organization can still call it while its only holds are for payment.",
  erasure:
    "A suspended organization can still call it, except while an abuse hold preserves evidence.",
  read: "A suspended organization can still call it.",
  remediation: "A suspended organization can still call it.",
} as const satisfies Record<PublicApiStanding, string>;

function authorizationDescription(route: PublicApiRouteContract) {
  if (!route.requiredAuthorization) return undefined;
  const required = route.principals
    ? `Requires ${route.requiredAuthorization}; admits ${route.principals.join(" and ")} callers.`
    : `Requires ${route.requiredAuthorization}.`;
  const grant = SERVICE_GRANTS[route.name];
  return grant
    ? `${required} A machine service whose principal holds ${grant} calls it with SigV4 at ${openApiPath(systemServicePath(route.path))}.`
    : required;
}

function publicRouteDescription(route: PublicApiRouteContract) {
  const sentences = [
    authorizationDescription(route),
    route.standing ? STANDING_DESCRIPTIONS[route.standing] : undefined,
  ].filter((sentence) => sentence !== undefined);
  return sentences.length > 0 ? sentences.join(" ") : undefined;
}

function publicRouteOperation(route: PublicApiRouteContract) {
  const description = publicRouteDescription(route);
  return {
    ...(description ? { description } : {}),
    operationId: route.name,
    parameters: [
      ...pathParameters(route),
      ...publicScopeParameters(route),
      ...publicQueryParameters(route),
      ...publicIdempotencyParameter(route),
    ],
    ...(route.requestBody
      ? {
          requestBody: {
            content: {
              "application/json": {
                schema: schemaReference(route.requestBody),
              },
            },
            required: route.requestBodyRequired ?? true,
          },
        }
      : {}),
    responses: publicRouteResponses(route),
    security: securityByAuthentication[route.authentication],
    ...(route.server ? { servers: operationServers[route.server] } : {}),
    tags: [route.tag],
  };
}

export function publicOpenApiPaths(routes: readonly PublicApiRouteContract[] = PUBLIC_API_ROUTES) {
  const paths: Record<string, Record<string, ReturnType<typeof publicRouteOperation>>> = {};

  for (const route of routes) {
    const path = openApiPath(route.path);
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = publicRouteOperation(route);
  }

  return paths;
}

export function publicOpenApiTags(routes: readonly PublicApiRouteContract[] = PUBLIC_API_ROUTES) {
  return Array.from(new Set(routes.map((route) => route.tag))).map((name) => ({
    name,
  }));
}

export function makeTenancyOpenApiSpec() {
  return {
    components: {
      schemas: tenancyOpenApiSchemas(),
      securitySchemes: {
        bearerAuth: {
          bearerFormat: "API key or JWT",
          scheme: "bearer",
          type: "http",
        },
      },
    },
    info: {
      title: "Deployments.ai Tenancy and Agent Lifecycle API",
      version: `${API_CONTRACT_VERSION}.0.0`,
    },
    openapi: "3.1.0",
    paths: tenancyOpenApiPaths(),
  } as const;
}

export interface PublicOpenApiSpec {
  readonly components: {
    readonly schemas: Readonly<Record<string, unknown>>;
    readonly securitySchemes: Readonly<Record<string, Readonly<Record<string, string>>>>;
  };
  readonly info: { readonly title: string; readonly version: string };
  readonly openapi: "3.1.0";
  readonly paths: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
  >;
  readonly tags: readonly { readonly name: string }[];
}

export function makePublicOpenApiSpec(
  options: { readonly includeAgentEmail?: boolean } = {},
): PublicOpenApiSpec {
  const routes =
    options.includeAgentEmail === false
      ? PUBLIC_API_ROUTES.filter((route) => route.tag !== "Agent Email")
      : PUBLIC_API_ROUTES;
  return {
    components: {
      schemas: publicOpenApiSchemas(),
      securitySchemes: {
        apiCredentialBearer: {
          bearerFormat: "Opaque service-account API credential",
          description: "Opaque bearer credential scoped to one service account and tenant.",
          scheme: "bearer",
          type: "http",
        },
        platformBearer: {
          bearerFormat: "API key or JWT",
          description: "Platform bearer credential accepted as an opaque API key or JWT.",
          scheme: "bearer",
          type: "http",
        },
        streamSessionBearer: {
          bearerFormat: "Thread stream session token",
          description: "Short-lived bearer token scoped to one thread stream.",
          scheme: "bearer",
          type: "http",
        },
        tenantJwt: {
          bearerFormat: "JWT",
          description: "Tenant JWT carrying organization, project, and environment claims.",
          scheme: "bearer",
          type: "http",
        },
      },
    },
    info: {
      title: "Deployments.ai Public API",
      version: `${API_CONTRACT_VERSION}.0.0`,
    },
    openapi: "3.1.0",
    paths: publicOpenApiPaths(routes),
    tags: publicOpenApiTags(routes),
  } as const;
}
