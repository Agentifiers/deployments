import {
  EndUserErasureOperationResponse,
  type GovernanceOperationResponse,
  ImmutableAuditExportResponse,
  TenantDataExportResponse,
  TenantErasureResponse,
  ThreadErasureOperationResponse,
} from "@deployments-ai/api-contract";
import { redactConversationErasure } from "@deployments-ai/db";
import type { GovernanceOperation } from "@deployments-ai/governance";
import { Schema } from "effect";
import type { CreateGovernanceApiOptions } from "./governance-api.ts";

const strict = { onExcessProperty: "error" } as const;

async function tenantOperationFields(
  createDownloadUrl: CreateGovernanceApiOptions["createDownloadUrl"],
  operation: GovernanceOperation,
) {
  const [download, archiveDownload] = await Promise.all([
    operation.output ? createDownloadUrl(operation.output) : undefined,
    operation.archive ? createDownloadUrl(operation.archive) : undefined,
  ]);
  const output = operation.output
    ? {
        ...(operation.kind === "audit-export" && operation.archive
          ? {
              ...(archiveDownload
                ? {
                    archiveDownloadUrl: archiveDownload.url,
                    archiveDownloadUrlExpiresAt: archiveDownload.expiresAt,
                  }
                : {}),
              archiveFileName: `audit-export-${operation.id}-records.jsonl`,
              archiveSha256: operation.archive.sha256,
              archiveSizeBytes: operation.archive.sizeBytes,
            }
          : {}),
        contentType:
          operation.kind === "audit-export"
            ? ("application/json" as const)
            : ("application/x-ndjson" as const),
        ...(download
          ? {
              downloadUrl: download.url,
              downloadUrlExpiresAt: download.expiresAt,
            }
          : {}),
        fileName:
          operation.kind === "audit-export"
            ? `audit-export-${operation.id}-manifest.json`
            : `tenant-export-${operation.id}.jsonl`,
        ...(operation.kind === "audit-export" ? { immutable: true as const } : {}),
        sha256: operation.output.sha256,
        sizeBytes: operation.output.sizeBytes,
      }
    : undefined;
  return {
    completedAt: operation.completedAt,
    createdAt: operation.createdAt,
    error: operation.error,
    expiresAt: operation.expiresAt,
    id: operation.id,
    kind: operation.kind,
    organizationId: operation.organizationId,
    ...(output ? { output } : {}),
    startedAt: operation.startedAt,
    status: operation.status,
    summary: operation.summary,
    updatedAt: operation.updatedAt,
    version: operation.version,
  };
}

function conversationErasureFields(operation: GovernanceOperation) {
  const redacted = redactConversationErasure(operation);
  if (!redacted) {
    throw new Error(`Governance operation ${operation.id} has no matching conversation erasure.`);
  }
  return redacted;
}

export async function operationResponse(
  createDownloadUrl: CreateGovernanceApiOptions["createDownloadUrl"],
  operation: GovernanceOperation,
): Promise<GovernanceOperationResponse> {
  switch (operation.kind) {
    case "audit-export":
      return Schema.decodeUnknownSync(
        ImmutableAuditExportResponse,
        strict,
      )(await tenantOperationFields(createDownloadUrl, operation));
    case "tenant-export":
      return Schema.decodeUnknownSync(
        TenantDataExportResponse,
        strict,
      )(await tenantOperationFields(createDownloadUrl, operation));
    case "tenant-erasure":
      return Schema.decodeUnknownSync(
        TenantErasureResponse,
        strict,
      )(await tenantOperationFields(createDownloadUrl, operation));
    case "thread-erasure":
      return Schema.decodeUnknownSync(
        ThreadErasureOperationResponse,
        strict,
      )(conversationErasureFields(operation));
    case "end-user-erasure":
      return Schema.decodeUnknownSync(
        EndUserErasureOperationResponse,
        strict,
      )(conversationErasureFields(operation));
  }
}
