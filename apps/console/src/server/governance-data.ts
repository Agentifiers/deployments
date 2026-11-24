import "@tanstack/react-start/server-only";
import { erasureState, type ErasureState } from "../governance/erasure-state.ts";
import {
  operationView,
  type ExportKind,
  type ExportResponse,
  type OperationView,
} from "../governance/operation-state.ts";
import type { RetentionPolicy } from "../governance/retention-state.ts";
import { PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";

export function loadRetentionPolicy(
  accessToken: string,
  organizationId: string,
): Promise<RetentionPolicy> {
  return callRoute(
    "getOrganizationRetentionPolicy",
    { path: { id: organizationId }, scope: { organizationId } },
    accessToken,
  );
}

export type EgressAllowlist = RouteResponse<"getOrganizationEgressAllowlist">;

export function loadEgressAllowlist(
  accessToken: string,
  organizationId: string,
): Promise<EgressAllowlist> {
  return callRoute(
    "getOrganizationEgressAllowlist",
    { path: { id: organizationId }, scope: { organizationId } },
    accessToken,
  );
}

export async function loadOperationPage(
  accessToken: string,
  organizationId: string,
  cursor: string | undefined,
): Promise<Page<OperationView>> {
  const page = await callRoute(
    "listGovernanceOperations",
    {
      path: { id: organizationId },
      query: { cursor, limit: PAGE_SIZE },
      scope: { organizationId },
    },
    accessToken,
  );
  return { items: page.items.map(operationView), nextCursor: page.nextCursor };
}

export function readExport(
  accessToken: string,
  organizationId: string,
  kind: ExportKind,
  operationId: string,
): Promise<ExportResponse> {
  const input = { path: { id: organizationId, operationId }, scope: { organizationId } };
  return kind === "tenant-export"
    ? callRoute("getTenantDataExport", input, accessToken)
    : callRoute("getImmutableAuditExport", input, accessToken);
}

export async function loadExport(
  accessToken: string,
  organizationId: string,
  kind: ExportKind,
  operationId: string,
): Promise<OperationView> {
  return operationView(await readExport(accessToken, organizationId, kind, operationId));
}

export async function loadOrganizationErasure(
  accessToken: string,
  organizationId: string,
): Promise<ErasureState> {
  const page = await callRoute(
    "listGovernanceOperations",
    {
      path: { id: organizationId },
      query: { kind: "tenant-erasure", limit: 1 },
      scope: { organizationId },
    },
    accessToken,
  );
  const [latest] = page.items;
  return erasureState(latest?.kind === "tenant-erasure" ? latest : undefined);
}

export async function loadErasure(
  accessToken: string,
  organizationId: string,
  operationId: string,
): Promise<ErasureState> {
  return erasureState(
    await callRoute(
      "getTenantErasure",
      { path: { id: organizationId, operationId }, scope: { organizationId } },
      accessToken,
    ),
  );
}
