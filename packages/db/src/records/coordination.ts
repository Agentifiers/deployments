import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  SecretReference,
  StringList,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  stateVersionFields,
  tenantScopeFields,
} from "../record-schema.ts";

export const ProviderMutationClaimRecord = makeRecordSchema("provider-mutation-claim", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  claimAttemptId: NonEmptyString,
  connectionId: Ulid,
  externalResult: Schema.optional(Metadata),
  id: Ulid,
  idempotencyKey: Schema.String,
  immutableIdentityHash: Schema.String,
  operation: Schema.String,
  reconciledAt: Schema.optional(Schema.String),
  runId: Ulid,
  status: Schema.Literals(["active", "failed", "reconciled", "releasable", "succeeded", "unknown"]),
  threadId: Ulid,
  toolCallId: Ulid,
});

// Serializes refreshers of one provider-connection credential generation so a rotating refresh
// token is never replayed; logically expired claims may be taken over by another refresher.
export const OAuthRefreshClaimRecord = makeRecordSchema(
  "oauth-refresh-claim",
  {
    ...mutableResourceFields,
    ...tenantScopeFields,
    connectionId: Ulid,
    credentialGeneration: NonNegativeSafeInteger,
    expiresAt: Timestamp,
    id: Ulid,
    owner: NonEmptyString.pipe(Schema.check(Schema.isMaxLength(128))),
  },
  { expiresAtField: "expiresAt" },
);

export const RuntimeLeaseRecord = makeRecordSchema("runtime-lease", {
  ...stateVersionFields,
  acquiredAt: Schema.String,
  environmentId: Schema.optional(Ulid),
  expiresAt: Timestamp,
  id: Ulid,
  leaseKey: Schema.String,
  organizationId: Schema.optional(Ulid),
  owner: Schema.String,
  projectId: Schema.optional(Ulid),
  renewedAt: Schema.optional(Schema.String),
  runId: Schema.optional(Ulid),
  threadId: Schema.optional(Ulid),
});

export const StreamSessionRecord = makeRecordSchema(
  "stream-session",
  {
    ...stateVersionFields,
    ...tenantScopeFields,
    createdAt: Timestamp,
    credentialRef: SecretReference,
    expiresAt: Timestamp,
    id: Ulid,
    scopes: StringList,
    threadId: Ulid,
  },
  { expiresAtField: "expiresAt" },
);

export const McpSessionRecord = makeRecordSchema(
  "mcp-session",
  {
    ...stateVersionFields,
    ...tenantScopeFields,
    connectionId: Ulid,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    id: Ulid,
    lastUsedAt: Schema.optional(Schema.String),
    mcpServerId: Ulid,
    providerSessionId: Schema.optional(Schema.String),
    status: Schema.Literals(["active", "expired", "failed", "revoked"]),
  },
  { expiresAtField: "expiresAt" },
);
