import { Schema } from "effect";
import { PublicId, Timestamp } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

/** Durable credential-vault owner types listed by the inventory, in pagination order. */
export const CREDENTIAL_REFERENCE_OWNER_TYPES = [
  "channel-binding",
  "mcp-server",
  "provider-application",
  "provider-connection",
  "tool-adapter",
  "webhook-endpoint",
] as const;

export const CredentialReferenceOwnerType = Schema.Literals(CREDENTIAL_REFERENCE_OWNER_TYPES);

/**
 * Metadata of one owner-held credential-vault reference. Secret values, ciphertext, data keys,
 * and hashes are never part of the inventory; `createdAt`/`updatedAt` are the owner's.
 */
export const CredentialReferenceResponse = Schema.Struct({
  createdAt: Timestamp,
  credentialId: PublicId,
  expiresAt: Schema.optional(Timestamp),
  generation: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  ownerId: PublicId,
  ownerName: Schema.optional(Schema.String),
  ownerStatus: Schema.String,
  ownerType: CredentialReferenceOwnerType,
  providerKey: Schema.optional(Schema.String),
  purpose: Schema.String,
  secretNames: Schema.optional(Schema.Array(Schema.String)),
  status: Schema.Literals(["active", "revoked"]),
  store: Schema.Literal("dynamodb-kms"),
  updatedAt: Timestamp,
});

export const ListCredentialReferencesResponse = Schema.Struct({
  items: Schema.Array(CredentialReferenceResponse),
  nextCursor: Schema.NullOr(Schema.String),
});

export const CREDENTIAL_REFERENCE_API_SCHEMAS = {
  CredentialReferenceResponse,
  ListCredentialReferencesResponse,
} as const;

export const CREDENTIAL_REFERENCE_API_ROUTES = [
  {
    authentication: "platform-bearer",
    errors: [400, 401, 403, 404, 422],
    idempotency: "none",
    method: "GET",
    name: "listCredentialReferences",
    path: "/v1/credential-references",
    queryParameters: [
      { name: "cursor", schema: { maxLength: 4_096, minLength: 1, type: "string" } },
      { name: "limit", schema: { maximum: 100, minimum: 1, type: "integer" } },
      {
        description: "Only list references held by this owner type.",
        name: "ownerType",
        schema: { enum: CREDENTIAL_REFERENCE_OWNER_TYPES, type: "string" },
      },
    ],
    requiredAuthorization: "secrets:read",
    responseBody: "ListCredentialReferencesResponse",
    scopeHeaders: "environment",
    successStatus: 200,
    tag: "Security",
  },
] as const satisfies readonly PublicApiRouteContract[];

export type CredentialReferenceApiRouteName =
  (typeof CREDENTIAL_REFERENCE_API_ROUTES)[number]["name"];
