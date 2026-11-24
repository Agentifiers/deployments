import { type Ulid } from "@deployments-ai/db";
import type { SpanId, TraceId } from "@deployments-ai/observability";

export const ids = Array.from(
  { length: 12 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
) as Ulid[];

export const context = {
  agentDefinitionId: ids[0]!,
  agentDeploymentId: ids[1]!,
  agentManifestHash: "sha256:manifest",
  agentReleaseId: ids[2]!,
  captureMode: "metadata-only" as const,
  environmentId: ids[3]!,
  organizationId: ids[4]!,
  projectId: ids[5]!,
  runId: ids[6]!,
  spanId: "0123456789abcdef" as SpanId,
  threadId: ids[7]!,
  traceId: "0123456789abcdef0123456789abcdef" as TraceId,
  workspaceId: ids[8]!,
};
