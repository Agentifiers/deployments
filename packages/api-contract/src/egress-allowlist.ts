import { Schema } from "effect";
import { PublicId, Timestamp } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

export const EgressAllowlistEntry = Schema.Struct({
  note: Schema.optionalKey(
    Schema.String.annotate({ description: "Why the origin is listed, 1 to 200 characters." }),
  ),
  origin: Schema.String.annotate({
    description:
      "A normalized https origin, `https://host[:port]` in lowercase with no path, query, credentials, or wildcard.",
  }),
});

export const ReplaceOrganizationEgressAllowlistRequest = Schema.Struct({
  entries: Schema.Array(EgressAllowlistEntry).annotate({
    description: "The whole list, at most 200 unique origins. It replaces the stored list.",
  }),
});

export const OrganizationEgressAllowlistResponse = Schema.Struct({
  entries: Schema.Array(EgressAllowlistEntry),
  organizationId: PublicId,
  updatedAt: Schema.NullOr(Timestamp),
  updatedByPrincipalId: Schema.NullOr(PublicId),
  version: Schema.Number.annotate({ description: "0 until the list is first saved." }),
});

export const OrganizationEgressAllowlistChangeResponse = Schema.Struct({
  allowlist: OrganizationEgressAllowlistResponse,
  changed: Schema.Boolean.annotate({
    description: "false when the stored list already had these origins and notes.",
  }),
});

export type EgressAllowlistEntry = typeof EgressAllowlistEntry.Type;
export type OrganizationEgressAllowlistResponse = typeof OrganizationEgressAllowlistResponse.Type;

export const EGRESS_ALLOWLIST_API_SCHEMAS = {
  OrganizationEgressAllowlistChangeResponse,
  OrganizationEgressAllowlistResponse,
  ReplaceOrganizationEgressAllowlistRequest,
} as const;

const EGRESS_ALLOWLIST_PATH = "/v1/organizations/:id/egress-allowlist";

/**
 * Origins that public-egress tools of an organization under a data boundary reach without
 * approval. Served by the tenancy API with governance scopes; writes need an owner or admin.
 */
export const EGRESS_ALLOWLIST_API_ROUTES = [
  {
    authentication: "platform-bearer",
    errors: [400, 401, 403, 404],
    idempotency: "none",
    method: "GET",
    name: "getOrganizationEgressAllowlist",
    path: EGRESS_ALLOWLIST_PATH,
    requiredAuthorization: "governance:read",
    responseBody: "OrganizationEgressAllowlistResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Governance",
  },
  {
    authentication: "platform-bearer",
    errors: [400, 401, 403, 404, 409, 422, 429],
    idempotency: "required",
    method: "PUT",
    name: "replaceOrganizationEgressAllowlist",
    path: EGRESS_ALLOWLIST_PATH,
    requestBody: "ReplaceOrganizationEgressAllowlistRequest",
    requiredAuthorization: "governance:write",
    responseBody: "OrganizationEgressAllowlistChangeResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Governance",
  },
] as const satisfies readonly PublicApiRouteContract[];
