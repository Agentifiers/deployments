import { jsonObjectProperty, objectSchema, stringProperty } from "../tool-definition-builders.ts";
import {
  acquisitionRead,
  acquisitionWrite,
  bodyFromFields,
  id,
  providerUrl,
  requireHttpsOriginBaseUrl,
} from "./common.ts";

const ORIGIN_POLICY = { mode: "verified_origin", requireHttps: true } as const;

function strapiBase(input: Record<string, unknown>): URL {
  return requireHttpsOriginBaseUrl(input, ["baseUrl"]);
}

function strapiContentType(input: Record<string, unknown>): string {
  const value = id(input, "contentType");
  if (!/^[a-z0-9][a-z0-9_-]*$/iu.test(value)) {
    throw new Error("Tool input contentType must be a single Strapi API ID");
  }
  return value;
}

export const strapiNativeHttpToolDefinitions = [
  acquisitionRead({
    buildUrl: (input) => providerUrl(strapiBase(input), ["api", strapiContentType(input)]),
    description: "List documents from a verified Strapi origin.",
    hostPolicy: ORIGIN_POLICY,
    hosts: [],
    inputSchema: objectSchema(
      { baseUrl: stringProperty("Verified HTTPS Strapi origin."), contentType: stringProperty() },
      ["baseUrl", "contentType"],
    ),
    provider: "strapi",
    requiredScopes: ["documents:read"],
    resourceTypes: ["origin"],
    sampleInput: { baseUrl: "https://cms.example.com", contentType: "articles" },
    toolName: "strapi.documents.list",
  }),
  acquisitionWrite({
    buildBody: (input) => bodyFromFields(input, ["data"]),
    buildUrl: (input) => providerUrl(strapiBase(input), ["api", strapiContentType(input)]),
    description: "Create a Strapi document at a verified origin after explicit approval.",
    hostPolicy: ORIGIN_POLICY,
    hosts: [],
    inputSchema: objectSchema(
      { baseUrl: stringProperty(), body: jsonObjectProperty(), contentType: stringProperty() },
      ["baseUrl", "body", "contentType"],
    ),
    method: "POST",
    provider: "strapi",
    requiredScopes: ["documents:write"],
    resourceTypes: ["origin"],
    sampleInput: {
      baseUrl: "https://cms.example.com",
      body: { data: { title: "Approved draft" } },
      contentType: "articles",
    },
    toolName: "strapi.documents.create",
  }),
] as const;
