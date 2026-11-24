import { requireToolString } from "../core.ts";
import { objectSchema, stringProperty } from "../tool-definition-builders.ts";
import { businessRead } from "./common.ts";

const HOSTS = ["company.clearbit.com", "person.clearbit.com"] as const;

function enrichmentUrl(
  input: Record<string, unknown>,
  host: (typeof HOSTS)[number],
  field: "domain" | "email",
  path: "/v2/companies/find" | "/v2/people/find",
): string {
  const value = requireToolString(input, field);
  const url = new URL(`https://${host}${path}`);
  url.searchParams.set(field, value);
  return url.toString();
}

export const clearbitNativeHttpToolDefinitions = [
  businessRead({
    auditSelectorKeys: ["domain"],
    buildUrl: (input) =>
      enrichmentUrl(input, "company.clearbit.com", "domain", "/v2/companies/find"),
    description: "Enrich one business domain with the legacy Clearbit Company API.",
    expectedHost: "company.clearbit.com",
    hosts: HOSTS,
    inputSchema: objectSchema({ domain: stringProperty("Company domain to enrich.") }, ["domain"]),
    provider: "clearbit",
    resourceTypes: ["account"],
    sampleInput: { domain: "example.com" },
    toolName: "clearbit.company.enrich",
  }),
  businessRead({
    auditSelectorKeys: ["email"],
    buildUrl: (input) => enrichmentUrl(input, "person.clearbit.com", "email", "/v2/people/find"),
    description: "Enrich one non-PHI business email address with the legacy Clearbit Person API.",
    expectedHost: "person.clearbit.com",
    hosts: HOSTS,
    inputSchema: objectSchema(
      { email: stringProperty("Non-PHI business email address to enrich.") },
      ["email"],
    ),
    provider: "clearbit",
    resourceTypes: ["person"],
    sampleInput: { email: "person@example.com" },
    toolName: "clearbit.person.enrich",
  }),
] as const;
