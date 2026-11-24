import "@tanstack/react-start/server-only";
import { PlatformApiError } from "../errors.ts";
import { ERASE_PHRASE } from "../governance/erasure-state.ts";
import {
  operationView,
  presignedPart,
  type DownloadPart,
  type ExportKind,
  type OperationView,
} from "../governance/operation-state.ts";
import { patchApplied, type RetentionPolicy } from "../governance/retention-state.ts";
import type { PresignedUrl } from "../presigned.ts";
import { readExport } from "./governance-data.ts";
import { callRoute as platformCallRoute, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export type CallRoute = typeof platformCallRoute;

export interface GovernanceMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly organizationId: string;
}

/**
 * The retention PATCH takes no expected version, so the edit re-reads the policy and refuses
 * when it changed after the dialog opened. A change landing between this read and the PATCH
 * still wins.
 */
export async function updateRetentionPolicy(
  {
    accessToken,
    body,
    expectedVersion,
    idempotencyKey,
    organizationId,
  }: GovernanceMutation & {
    readonly body: unknown;
    readonly expectedVersion: number;
  },
  callRoute: CallRoute = platformCallRoute,
): Promise<RetentionPolicy> {
  const patch = decodeRequestBody(
    "updateOrganizationRetentionPolicy",
    "UpdateOrganizationRetentionPolicyRequest",
    body,
  );
  const input = { path: { id: organizationId }, scope: { organizationId } };
  const latest = await callRoute("getOrganizationRetentionPolicy", input, accessToken);
  if (latest.version !== expectedVersion) {
    if (patchApplied(latest, patch)) return latest;
    throw new PlatformApiError("updateOrganizationRetentionPolicy", {
      code: "retention_policy_changed",
      status: 409,
      title: "Someone changed the retention policy after you opened this dialog.",
    });
  }
  return callRoute(
    "updateOrganizationRetentionPolicy",
    { ...input, body: patch, idempotencyKey },
    accessToken,
  );
}

/** Replaces the organization's egress allowlist with the entries the form holds. */
export async function replaceEgressAllowlist(
  {
    accessToken,
    body,
    idempotencyKey,
    organizationId,
  }: GovernanceMutation & { readonly body: unknown },
  callRoute: CallRoute = platformCallRoute,
): Promise<RouteResponse<"replaceOrganizationEgressAllowlist">> {
  return callRoute(
    "replaceOrganizationEgressAllowlist",
    {
      body: decodeRequestBody(
        "replaceOrganizationEgressAllowlist",
        "ReplaceOrganizationEgressAllowlistRequest",
        body,
      ),
      idempotencyKey,
      path: { id: organizationId },
      scope: { organizationId },
    },
    accessToken,
  );
}

export async function requestExport({
  accessToken,
  idempotencyKey,
  kind,
  organizationId,
}: GovernanceMutation & { readonly kind: ExportKind }): Promise<OperationView> {
  const input = { idempotencyKey, path: { id: organizationId }, scope: { organizationId } };
  return operationView(
    kind === "tenant-export"
      ? await platformCallRoute("createTenantDataExport", input, accessToken)
      : await platformCallRoute("createImmutableAuditExport", input, accessToken),
  );
}

export async function requestErasure({
  accessToken,
  idempotencyKey,
  organizationId,
}: GovernanceMutation): Promise<OperationView> {
  return operationView(
    await platformCallRoute(
      "createTenantErasure",
      {
        body: { confirmation: ERASE_PHRASE },
        idempotencyKey,
        path: { id: organizationId },
        scope: { organizationId },
      },
      accessToken,
    ),
  );
}

export async function mintExportDownload({
  accessToken,
  kind,
  operationId,
  organizationId,
  part,
}: {
  readonly accessToken: string;
  readonly kind: ExportKind;
  readonly operationId: string;
  readonly organizationId: string;
  readonly part: DownloadPart;
}): Promise<PresignedUrl> {
  const response = await readExport(accessToken, organizationId, kind, operationId);
  const url = presignedPart(response, part);
  if (url === undefined) {
    throw new PlatformApiError(
      kind === "tenant-export" ? "getTenantDataExport" : "getImmutableAuditExport",
      {
        code: "download_unavailable",
        status: 409,
        title: "This export has no file to download yet.",
      },
    );
  }
  return url;
}
