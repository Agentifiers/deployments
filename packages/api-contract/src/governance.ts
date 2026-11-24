import { Schema } from "effect";
import { ConversationErasure } from "./conversation-erasure-contracts.ts";
import { Cursor, Metadata, PublicId, Timestamp } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

function boundedInteger(minimum: number, maximum: number, label: string) {
  return Schema.Number.pipe(
    Schema.check(
      Schema.isInt({ message: `${label} must be an integer.` }),
      Schema.isGreaterThanOrEqualTo(minimum, {
        message: `${label} must be at least ${minimum}.`,
      }),
      Schema.isLessThanOrEqualTo(maximum, {
        message: `${label} must not exceed ${maximum}.`,
      }),
    ),
  );
}

export const RetentionDays = boundedInteger(1, 3_650, "Retention days");
export const AuditRetentionDays = boundedInteger(365, 3_650, "Audit retention days");

export const RetentionResource = Schema.Literals([
  "artifacts",
  "audit",
  "events",
  "messages",
  "runs",
  "threads",
]);

const retentionPolicyFields = {
  artifacts: RetentionDays,
  audit: AuditRetentionDays,
  events: RetentionDays,
  messages: RetentionDays,
  runs: RetentionDays,
  threads: RetentionDays,
} as const;

export const UpdateOrganizationRetentionPolicyRequest = Schema.Struct({
  artifacts: Schema.optional(RetentionDays),
  audit: Schema.optional(AuditRetentionDays),
  events: Schema.optional(RetentionDays),
  messages: Schema.optional(RetentionDays),
  runs: Schema.optional(RetentionDays),
  threads: Schema.optional(RetentionDays),
}).pipe(
  Schema.check(
    Schema.isMinProperties(1, {
      message: "Retention policy updates must change at least one resource.",
    }),
  ),
);

export const OrganizationRetentionPolicyResponse = Schema.Struct({
  ...retentionPolicyFields,
  createdAt: Timestamp,
  organizationId: PublicId,
  updatedAt: Timestamp,
  updatedByPrincipalId: PublicId,
  version: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0, {
        message: "Retention policy versions must not be negative.",
      }),
    ),
  ),
});

export const GovernanceJobStatus = Schema.Literals([
  "canceled",
  "completed",
  "failed",
  "pending",
  "running",
]);

const operationVersion = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1, {
      message: "Governance operation versions must start at 1.",
    }),
  ),
);

const governanceOperationFields = {
  completedAt: Schema.optional(Timestamp),
  createdAt: Timestamp,
  error: Schema.optional(Metadata),
  expiresAt: Schema.optional(Timestamp),
  id: PublicId,
  organizationId: PublicId,
  startedAt: Schema.optional(Timestamp),
  status: GovernanceJobStatus,
  summary: Schema.optional(Metadata),
  updatedAt: Timestamp,
  version: operationVersion,
} as const;

const nonEmptyDownloadUrl = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1, { message: "Download URLs must not be empty." })),
);

const exportOutputFields = {
  downloadUrl: Schema.optional(nonEmptyDownloadUrl),
  downloadUrlExpiresAt: Schema.optional(Timestamp),
  fileName: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1, { message: "Export file names must not be empty." })),
  ),
  sha256: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^[a-f0-9]{64}$/u, {
        message: "Export checksums must use lowercase 64-character SHA-256 hex.",
      }),
    ),
  ),
  sizeBytes: Schema.Number.pipe(
    Schema.check(
      Schema.isInt({ message: "Export sizes must be integers." }),
      Schema.isGreaterThanOrEqualTo(0, {
        message: "Export sizes must not be negative.",
      }),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
} as const;

export const GovernanceExportOutputResponse = Schema.Struct({
  ...exportOutputFields,
  contentType: Schema.Literal("application/x-ndjson"),
});

export const ImmutableAuditOutputResponse = Schema.Struct({
  ...exportOutputFields,
  archiveDownloadUrl: Schema.optional(nonEmptyDownloadUrl),
  archiveDownloadUrlExpiresAt: Schema.optional(Timestamp),
  archiveFileName: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1, { message: "Audit archive file names must not be empty." })),
  ),
  archiveSha256: exportOutputFields.sha256,
  archiveSizeBytes: exportOutputFields.sizeBytes,
  contentType: Schema.Literal("application/json"),
  immutable: Schema.Literal(true),
});

export const TenantDataExportResponse = Schema.Struct({
  ...governanceOperationFields,
  kind: Schema.Literal("tenant-export"),
  output: Schema.optional(GovernanceExportOutputResponse),
}).pipe(
  Schema.check(
    Schema.makeFilter((input) =>
      input.status !== "completed" || input.output !== undefined
        ? undefined
        : "Completed tenant data exports must include output metadata.",
    ),
  ),
);

export const CreateTenantErasureRequest = Schema.Struct({
  confirmation: Schema.Literal("ERASE"),
});

const erasedRowCount = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Erased row counts must be integers." }),
    Schema.isGreaterThanOrEqualTo(0, { message: "Erased row counts must not be negative." }),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
);

export const TenantErasureMemorySearchSummary = Schema.Struct({
  backupsExpireBy: Timestamp,
});

export const TenantErasureObservabilitySummary = Schema.Struct({
  backupsExpireBy: Timestamp,
  clickhouseRowsDeleted: erasedRowCount,
  icebergRowsDeleted: erasedRowCount,
  physicalRemovalBy: Timestamp,
});

export const TenantErasureSummary = Schema.Struct({
  auditRootHash: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^[a-f0-9]{64}$/u, {
        message: "Erasure audit root hashes must use lowercase 64-character SHA-256 hex.",
      }),
    ),
  ),
  memorySearch: Schema.optional(TenantErasureMemorySearchSummary),
  observability: Schema.optional(TenantErasureObservabilitySummary),
  recordsDeleted: erasedRowCount,
});

export const TenantErasureResponse = Schema.Struct({
  ...governanceOperationFields,
  kind: Schema.Literal("tenant-erasure"),
  output: Schema.optional(ImmutableAuditOutputResponse),
  summary: Schema.optional(TenantErasureSummary),
});

export const ImmutableAuditExportResponse = Schema.Struct({
  ...governanceOperationFields,
  kind: Schema.Literal("audit-export"),
  output: Schema.optional(ImmutableAuditOutputResponse),
}).pipe(
  Schema.check(
    Schema.makeFilter((input) =>
      input.status !== "completed" || input.output !== undefined
        ? undefined
        : "Completed immutable audit exports must include output metadata.",
    ),
  ),
);

const {
  kind: _runtimeKind,
  threadId: _runtimeThreadId,
  ...erasureFieldsWithoutRuntimeKind
} = ConversationErasure.fields;

export const ThreadErasureOperationResponse = Schema.Struct({
  ...erasureFieldsWithoutRuntimeKind,
  kind: Schema.Literal("thread-erasure"),
  threadId: PublicId,
});

export const EndUserErasureOperationResponse = Schema.Struct({
  ...erasureFieldsWithoutRuntimeKind,
  kind: Schema.Literal("end-user-erasure"),
});

export const GOVERNANCE_OPERATION_KINDS = [
  "audit-export",
  "end-user-erasure",
  "tenant-erasure",
  "tenant-export",
  "thread-erasure",
] as const;

export const GovernanceOperationKind = Schema.Literals(GOVERNANCE_OPERATION_KINDS);

export const GovernanceOperationResponse = Schema.Union([
  ImmutableAuditExportResponse,
  TenantDataExportResponse,
  TenantErasureResponse,
  ThreadErasureOperationResponse,
  EndUserErasureOperationResponse,
]);

export const GovernanceOperationPageResponse = Schema.Struct({
  items: Schema.Array(GovernanceOperationResponse),
  nextCursor: Schema.optional(Cursor),
});

export const GOVERNANCE_API_SCHEMAS = {
  AuditRetentionDays,
  CreateTenantErasureRequest,
  EndUserErasureOperationResponse,
  GovernanceExportOutputResponse,
  GovernanceJobStatus,
  GovernanceOperationKind,
  GovernanceOperationPageResponse,
  GovernanceOperationResponse,
  ImmutableAuditExportResponse,
  ImmutableAuditOutputResponse,
  OrganizationRetentionPolicyResponse,
  RetentionDays,
  RetentionResource,
  TenantDataExportResponse,
  TenantErasureMemorySearchSummary,
  TenantErasureObservabilitySummary,
  TenantErasureResponse,
  TenantErasureSummary,
  ThreadErasureOperationResponse,
  UpdateOrganizationRetentionPolicyRequest,
} as const;

export type GovernanceApiSchemaName = keyof typeof GOVERNANCE_API_SCHEMAS;
export type OrganizationRetentionPolicyResponse = typeof OrganizationRetentionPolicyResponse.Type;
export type UpdateOrganizationRetentionPolicyRequest =
  typeof UpdateOrganizationRetentionPolicyRequest.Type;
export type TenantDataExportResponse = typeof TenantDataExportResponse.Type;
export type CreateTenantErasureRequest = typeof CreateTenantErasureRequest.Type;
export type TenantErasureResponse = typeof TenantErasureResponse.Type;
export type ImmutableAuditExportResponse = typeof ImmutableAuditExportResponse.Type;
export type ThreadErasureOperationResponse = typeof ThreadErasureOperationResponse.Type;
export type EndUserErasureOperationResponse = typeof EndUserErasureOperationResponse.Type;
export type GovernanceOperationKind = typeof GovernanceOperationKind.Type;
export type GovernanceOperationResponse = typeof GovernanceOperationResponse.Type;
export type GovernanceOperationPageResponse = typeof GovernanceOperationPageResponse.Type;

type GovernanceRouteInput = Omit<
  PublicApiRouteContract,
  "authentication" | "errors" | "scopeHeaders" | "tag"
> & {
  readonly requestBody?: GovernanceApiSchemaName;
  readonly responseBody: GovernanceApiSchemaName;
};

const governanceReadErrors = [400, 401, 403, 404, 410, 422, 500, 503] as const;
const governanceMutationErrors = [400, 401, 403, 404, 409, 410, 422, 429, 500, 503] as const;

function governanceRoute<const Contract extends GovernanceRouteInput>(
  contract: Contract,
): PublicApiRouteContract & Contract {
  return {
    authentication: "platform-bearer" as const,
    errors: contract.method === "GET" ? governanceReadErrors : governanceMutationErrors,
    scopeHeaders: "organization" as const,
    tag: "Governance" as const,
    ...contract,
  };
}

export const GOVERNANCE_API_ROUTES = [
  governanceRoute({
    idempotency: "none",
    method: "GET",
    name: "getOrganizationRetentionPolicy",
    path: "/v1/organizations/:id/retention-policy",
    requiredAuthorization: "governance:read",
    responseBody: "OrganizationRetentionPolicyResponse",
    successStatus: 200,
  }),
  governanceRoute({
    idempotency: "required",
    method: "PATCH",
    name: "updateOrganizationRetentionPolicy",
    path: "/v1/organizations/:id/retention-policy",
    requestBody: "UpdateOrganizationRetentionPolicyRequest",
    requiredAuthorization: "governance:write",
    responseBody: "OrganizationRetentionPolicyResponse",
    successStatus: 200,
  }),
  governanceRoute({
    idempotency: "required",
    method: "POST",
    name: "createTenantDataExport",
    path: "/v1/organizations/:id/data-exports",
    requiredAuthorization: "governance:write",
    responseBody: "TenantDataExportResponse",
    standing: "read",
    successStatus: 202,
  }),
  governanceRoute({
    idempotency: "none",
    method: "GET",
    name: "getTenantDataExport",
    path: "/v1/organizations/:id/data-exports/:operationId",
    requiredAuthorization: "governance:read",
    responseBody: "TenantDataExportResponse",
    successStatus: 200,
  }),
  governanceRoute({
    idempotency: "required",
    method: "POST",
    name: "createTenantErasure",
    path: "/v1/organizations/:id/erasures",
    requestBody: "CreateTenantErasureRequest",
    requiredAuthorization: "governance:write",
    responseBody: "TenantErasureResponse",
    standing: "erasure",
    successStatus: 202,
  }),
  governanceRoute({
    idempotency: "none",
    method: "GET",
    name: "getTenantErasure",
    path: "/v1/organizations/:id/erasures/:operationId",
    requiredAuthorization: "governance:read",
    responseBody: "TenantErasureResponse",
    successStatus: 200,
  }),
  governanceRoute({
    idempotency: "required",
    method: "POST",
    name: "createImmutableAuditExport",
    path: "/v1/organizations/:id/audit-exports",
    requiredAuthorization: "governance:write",
    responseBody: "ImmutableAuditExportResponse",
    standing: "read",
    successStatus: 202,
  }),
  governanceRoute({
    idempotency: "none",
    method: "GET",
    name: "getImmutableAuditExport",
    path: "/v1/organizations/:id/audit-exports/:operationId",
    requiredAuthorization: "governance:read",
    responseBody: "ImmutableAuditExportResponse",
    successStatus: 200,
  }),
  governanceRoute({
    idempotency: "none",
    method: "GET",
    name: "listGovernanceOperations",
    path: "/v1/organizations/:id/governance-operations",
    queryParameters: [
      {
        description: "Opaque cursor from a previous page.",
        name: "cursor",
        schema: { maxLength: 1_024, minLength: 1, type: "string" },
      },
      { name: "limit", schema: { maximum: 100, minimum: 1, type: "integer" } },
      {
        description: "Restrict results to one operation kind.",
        name: "kind",
        schema: { enum: [...GOVERNANCE_OPERATION_KINDS], type: "string" },
      },
      {
        description: "Restrict results to one operation status.",
        name: "status",
        schema: {
          enum: ["canceled", "completed", "failed", "pending", "running"],
          type: "string",
        },
      },
    ],
    requiredAuthorization: "governance:read",
    responseBody: "GovernanceOperationPageResponse",
    successStatus: 200,
  }),
] as const satisfies readonly PublicApiRouteContract[];
