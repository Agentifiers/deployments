import type { Ulid } from "@deployments-ai/db";

export const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
export const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
export const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
export const AGENT_DEPLOYMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
export const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
export const ALLOCATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
export const WORKSPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;

export const createInput = {
  executionTargetId: AGENT_DEPLOYMENT_ID,
  executionTargetKind: "agent-deployment" as const,
  allocationId: ALLOCATION_ID,
  environmentId: ENVIRONMENT_ID,
  isolationMode: "run-ephemeral" as const,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  runId: RUN_ID,
  workspaceId: WORKSPACE_ID,
};

export function jsonBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON string request body");
  return JSON.parse(body);
}
