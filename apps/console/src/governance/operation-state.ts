import type {
  GovernanceOperationResponse,
  ImmutableAuditExportResponse,
  TenantDataExportResponse,
} from "@deployments-ai/api-contract/governance";
import type { FreshLinkDisposition } from "../presigned.ts";

export type OperationKind = GovernanceOperationResponse["kind"];
export type OperationStatus = GovernanceOperationResponse["status"];
export type ExportResponse = ImmutableAuditExportResponse | TenantDataExportResponse;

export const EXPORT_KINDS = [
  "tenant-export",
  "audit-export",
] as const satisfies readonly ExportResponse["kind"][];
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportKind(kind: OperationKind): kind is ExportKind {
  return EXPORT_KINDS.some((exportKind) => exportKind === kind);
}

export const EXPORT_SEGMENTS = {
  "audit-export": "audit-exports",
  "tenant-export": "data-exports",
} as const satisfies Readonly<Record<ExportKind, string>>;

export function exportKindOf(segment: string): ExportKind | undefined {
  return EXPORT_KINDS.find((kind) => EXPORT_SEGMENTS[kind] === segment);
}

export const OPERATION_LABELS: Readonly<Record<OperationKind, string>> = {
  "audit-export": "Audit export",
  "end-user-erasure": "End-user erasure",
  "tenant-erasure": "Organization erasure",
  "tenant-export": "Data export",
  "thread-erasure": "Thread erasure",
};

export interface OperationError {
  readonly code: string;
  readonly message: string;
}

export type Phase =
  | { readonly status: "pending" }
  | { readonly status: "running"; readonly startedAt?: string }
  | { readonly status: "completed"; readonly completedAt: string }
  | { readonly status: "failed"; readonly error: OperationError }
  | { readonly status: "canceled"; readonly error?: OperationError };

export interface FileFacts {
  readonly fileName: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/**
 * A tenant export over the single-file limit becomes a manifest of storage parts that the API
 * does not presign, so only the manifest is offered.
 */
export type Artifact =
  | { readonly kind: "single_file"; readonly file: FileFacts; readonly recordCount?: number }
  | { readonly kind: "multipart_manifest"; readonly file: FileFacts; readonly recordCount?: number }
  | {
      readonly kind: "audit_bundle";
      readonly archive: FileFacts;
      readonly manifest: FileFacts;
      readonly recordCount?: number;
      readonly retainedUntil?: string;
      readonly rootHash?: string;
    };

/** One governance operation without its presigned URLs, which expire 300 s after each read. */
export interface OperationView {
  readonly artifact?: Artifact;
  readonly createdAt: string;
  readonly id: string;
  readonly kind: OperationKind;
  readonly phase: Phase;
}

export type DownloadPart = "archive" | "output";

export interface DownloadLink {
  readonly disposition: FreshLinkDisposition;
  readonly label: string;
  readonly part: DownloadPart;
}

/**
 * The API presigns without attachment disposition, so a JSON manifest renders inline and opens in
 * a tab, while files a browser cannot render download in place.
 */
export const DOWNLOAD_LINKS: Readonly<Record<Artifact["kind"], readonly DownloadLink[]>> = {
  audit_bundle: [
    { disposition: "view", label: "View manifest", part: "output" },
    { disposition: "download", label: "Download records", part: "archive" },
  ],
  multipart_manifest: [{ disposition: "view", label: "View manifest", part: "output" }],
  single_file: [{ disposition: "download", label: "Download", part: "output" }],
};

const UNRECORDED_ERROR: OperationError = {
  code: "unknown",
  message: "The platform recorded no reason.",
};

function operationError(error: Readonly<Record<string, unknown>> | undefined) {
  if (error === undefined) return undefined;
  const { code, message } = error;
  return typeof code === "string" && typeof message === "string"
    ? { code, message }
    : UNRECORDED_ERROR;
}

function phase(response: GovernanceOperationResponse): Phase {
  switch (response.status) {
    case "pending":
      return { status: "pending" };
    case "running":
      return "startedAt" in response && response.startedAt !== undefined
        ? { startedAt: response.startedAt, status: "running" }
        : { status: "running" };
    case "completed":
      return { completedAt: response.completedAt ?? response.updatedAt, status: "completed" };
    case "failed":
      return { error: operationError(response.error) ?? UNRECORDED_ERROR, status: "failed" };
    case "canceled": {
      const error = operationError(response.error);
      return error === undefined ? { status: "canceled" } : { error, status: "canceled" };
    }
  }
}

function artifact(response: GovernanceOperationResponse): Artifact | undefined {
  if (response.kind !== "tenant-export" && response.kind !== "audit-export") return undefined;
  if (response.output === undefined) return undefined;
  const { fileName, sha256, sizeBytes } = response.output;
  const file = { fileName, sha256, sizeBytes };
  const { format, recordCount, retainedUntil, rootHash } = response.summary ?? {};
  const counted = typeof recordCount === "number" ? { recordCount } : {};
  if (response.kind === "tenant-export") {
    const storedAsManifest = response.output.downloadUrl
      ?.split("?")[0]
      ?.endsWith("/tenant-manifest.json");
    const kind =
      format === "deployments-ai-tenant-export/v2" || storedAsManifest
        ? "multipart_manifest"
        : "single_file";
    return { file, kind, ...counted };
  }
  const { archiveFileName, archiveSha256, archiveSizeBytes } = response.output;
  return {
    archive: { fileName: archiveFileName, sha256: archiveSha256, sizeBytes: archiveSizeBytes },
    kind: "audit_bundle",
    manifest: file,
    ...counted,
    ...(typeof retainedUntil === "string" ? { retainedUntil } : {}),
    ...(typeof rootHash === "string" ? { rootHash } : {}),
  };
}

export function operationView(response: GovernanceOperationResponse): OperationView {
  const result = artifact(response);
  return {
    createdAt: response.createdAt,
    id: response.id,
    kind: response.kind,
    phase: phase(response),
    ...(result === undefined ? {} : { artifact: result }),
  };
}

export function isInFlight(status: OperationStatus): boolean {
  return status === "pending" || status === "running";
}

export function presignedPart(
  response: ExportResponse,
  part: DownloadPart,
): { readonly expiresAt: string; readonly url: string } | undefined {
  const output = response.output;
  if (output === undefined) return undefined;
  if (part === "output") {
    return output.downloadUrl && output.downloadUrlExpiresAt
      ? { expiresAt: output.downloadUrlExpiresAt, url: output.downloadUrl }
      : undefined;
  }
  return "archiveDownloadUrl" in output &&
    output.archiveDownloadUrl &&
    output.archiveDownloadUrlExpiresAt
    ? { expiresAt: output.archiveDownloadUrlExpiresAt, url: output.archiveDownloadUrl }
    : undefined;
}

export type RetryPath = "new_request" | "none" | "resume_same";

export function retryPath(view: Pick<OperationView, "kind" | "phase">): RetryPath {
  const ended = view.phase.status === "failed" || view.phase.status === "canceled";
  if (!ended) return "none";
  if (view.kind === "tenant-erasure") return "resume_same";
  return isExportKind(view.kind) ? "new_request" : "none";
}
