import { AppRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";

export const APP_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC0";
export const APP_ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC1";

export function appRecord(
  overrides: {
    readonly id?: string;
    readonly lifecycle?: AppRecord["data"]["lifecycle"];
    readonly slug?: string;
  } = {},
): AppRecord {
  const lifecycle = overrides.lifecycle ?? { liveReleaseId: null, state: "active" };
  return Schema.decodeUnknownSync(AppRecord)(
    withCanonicalRecordKeys({
      data: {
        access: { organizationMembers: "none" },
        agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
        clusterKey: "default",
        createdAt: "2026-10-08T12:00:00.000Z",
        createdBy: { principalId: null, runId: "01ARZ3NDEKTSV4RRFFQ69G5FC3" },
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
        id: overrides.id ?? APP_ID,
        lifecycle,
        name: "Payroll",
        organizationId: APP_ORGANIZATION_ID,
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FC5",
        slug: overrides.slug ?? "payroll",
        status: lifecycle.state,
        updatedAt: "2026-10-08T12:00:00.000Z",
        version: 2,
        workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FC6",
      },
      itemType: "app" as const,
    }),
  );
}
