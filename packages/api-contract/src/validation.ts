import { agentManifestDepthIssue } from "@deployments-ai/agent-manifest/semantics";
import { Schema } from "effect";
import { tenancyRouteContract, type TenancyRouteName } from "./routes.ts";
import { TENANCY_API_SCHEMAS } from "./schema-registry.ts";
import { PUBLIC_API_SCHEMAS } from "./schema-registry.ts";
import { publicRouteContract, type PublicRouteName } from "./product.ts";

const strictOptions = { onExcessProperty: "error" } as const;
const AgentManifestDepthPreflight = Schema.Unknown.pipe(
  Schema.check(
    Schema.makeFilter<unknown>((input) => {
      const issue = agentManifestDepthIssue(input);
      return issue ? `${issue.path}: ${issue.message}` : undefined;
    }),
  ),
);

function preflightAgentManifest(routeName: TenancyRouteName, request: unknown) {
  if (routeName !== "createAgentDefinition" && routeName !== "updateAgentDefinition") return;
  const manifest =
    request && typeof request === "object" && !Array.isArray(request)
      ? (request as Readonly<Record<string, unknown>>).manifest
      : undefined;
  Schema.decodeUnknownSync(AgentManifestDepthPreflight)(manifest);
}

export function decodeTenancyRequest(routeName: TenancyRouteName, input: unknown): unknown {
  const route = tenancyRouteContract(routeName);
  if (!route.requestBody) throw new TypeError(`Route ${routeName} does not accept a request body.`);
  const request = input === undefined && route.requestBodyRequired === false ? {} : input;
  preflightAgentManifest(routeName, request);
  return Schema.decodeUnknownSync(TENANCY_API_SCHEMAS[route.requestBody], strictOptions)(request);
}

export function decodeTenancyQuery(routeName: TenancyRouteName, input: unknown): unknown {
  const route = tenancyRouteContract(routeName);
  if (route.method !== "GET" || !route.name.startsWith("list")) {
    throw new TypeError(`Route ${routeName} does not accept tenancy list query parameters.`);
  }
  const query: unknown =
    input && typeof input === "object" && !Array.isArray(input)
      ? { ...(input as Readonly<Record<string, unknown>>) }
      : input;
  if (query && typeof query === "object") {
    const values = query as Record<string, unknown>;
    if (typeof values.limit === "string" && /^\d+$/u.test(values.limit)) {
      values.limit = Number(values.limit);
    }
  }
  return Schema.decodeUnknownSync(TENANCY_API_SCHEMAS.ListQuery, strictOptions)(query ?? {});
}

export function decodeTenancyIdempotencyKey(routeName: TenancyRouteName, input: unknown): unknown {
  const route = tenancyRouteContract(routeName);
  if (!route.idempotent) {
    throw new TypeError(`Route ${routeName} does not accept an idempotency key.`);
  }
  return Schema.decodeUnknownSync(TENANCY_API_SCHEMAS.IdempotencyKey, strictOptions)(input);
}

export function decodeTenancyResponse(routeName: TenancyRouteName, input: unknown): unknown {
  const route = tenancyRouteContract(routeName);
  return Schema.decodeUnknownSync(TENANCY_API_SCHEMAS[route.responseBody], strictOptions)(input);
}

export function decodePublicRequest(routeName: PublicRouteName, input: unknown): unknown {
  const route = publicRouteContract(routeName);
  if (!route.requestBody) throw new TypeError(`Route ${routeName} does not accept a request body.`);
  const request = input === undefined && route.requestBodyRequired === false ? {} : input;
  const schema = PUBLIC_API_SCHEMAS[route.requestBody as keyof typeof PUBLIC_API_SCHEMAS];
  if (!schema) throw new TypeError(`Route ${routeName} references an unknown request schema.`);
  return Schema.decodeUnknownSync(schema, strictOptions)(request);
}

export function decodePublicResponse(routeName: PublicRouteName, input: unknown): unknown {
  const route = publicRouteContract(routeName);
  const schema = PUBLIC_API_SCHEMAS[route.responseBody as keyof typeof PUBLIC_API_SCHEMAS];
  if (!schema) throw new TypeError(`Route ${routeName} references an unknown response schema.`);
  return Schema.decodeUnknownSync(schema, strictOptions)(input);
}
