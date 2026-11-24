import {
  DatabaseError,
  organizationNotStoppedCondition,
  organizationNotSuspendedCondition,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { isDeepStrictEqual } from "node:util";

/** Evaluates the two standing conditions against the stored standing record, as DynamoDB would. */
function standingConditionFails(
  operation: Extract<TransactionOperation, { readonly kind: "condition-check" }>,
  existing: PlatformRecord | undefined,
): boolean {
  if (existing?.itemType !== "organization-standing" || !existing.data.suspension) return false;
  const { organizationId } = existing.data;
  if (isDeepStrictEqual(operation, organizationNotSuspendedCondition(organizationId))) return true;
  return (
    isDeepStrictEqual(operation, organizationNotStoppedCondition(organizationId)) &&
    existing.data.suspension.haltMode !== "drain"
  );
}

export function assertSimulatedConditionCheck(
  operation: Extract<TransactionOperation, { readonly kind: "condition-check" }>,
  existing: PlatformRecord | undefined,
): void {
  if (standingConditionFails(operation, existing)) {
    throw new DatabaseError({
      cause: new Error("simulated organization standing condition failure"),
      message: "simulated organization standing condition failure",
      operation: "transact-write",
      reason: "conflict",
      table: "control",
    });
  }
  const values = operation.expressionAttributeValues;
  const callbackItemType = values?.[":itemType"];
  if (
    operation.table === "execution" &&
    (callbackItemType === "run" ||
      callbackItemType === "workflow-execution" ||
      callbackItemType === "approval" ||
      callbackItemType === "workflow-approval")
  ) {
    const data = existing?.data as Readonly<Record<string, unknown>> | undefined;
    const commonMatches =
      existing?.itemType === callbackItemType &&
      data?.status ===
        (callbackItemType === "run" || callbackItemType === "workflow-execution"
          ? values?.[":running"]
          : values?.[":approved"]) &&
      data?.version === values?.[":version"] &&
      data?.organizationId === values?.[":organizationId"] &&
      data?.projectId === values?.[":projectId"] &&
      data?.environmentId === values?.[":environmentId"] &&
      data?.id === (values?.[":runId"] ?? values?.[":approvalId"]);
    const workspaceMatches =
      ":workspaceId" in (values ?? {})
        ? data?.workspaceId === values?.[":workspaceId"]
        : !operation.conditionExpression.includes("#workspaceId") ||
          data?.workspaceId === undefined;
    const expiryMatches =
      ":expiresAt" in (values ?? {})
        ? data?.expiresAt === values?.[":expiresAt"] &&
          typeof data?.expiresAt === "string" &&
          data.expiresAt > String(values?.[":observedAt"])
        : !operation.conditionExpression.includes("#expiresAt") || data?.expiresAt === undefined;
    const identityMatches =
      callbackItemType === "run"
        ? data?.threadId === values?.[":threadId"] &&
          data?.agentDeploymentId === values?.[":agentDeploymentId"] &&
          data?.agentReleaseId === values?.[":agentReleaseId"]
        : callbackItemType === "workflow-execution"
          ? data?.activeStepAttemptId === values?.[":activeStepAttemptId"]
          : callbackItemType === "approval"
            ? data?.runId === values?.[":runId"] &&
              data?.toolCallId === values?.[":toolCallId"] &&
              data?.requestedByAgentDeploymentId === values?.[":agentDeploymentId"]
            : data?.workflowExecutionId === values?.[":workflowExecutionId"];
    if (!commonMatches || !workspaceMatches || !expiryMatches || !identityMatches) {
      throw new DatabaseError({
        cause: new Error("simulated callback authorization condition conflict"),
        message: "simulated callback authorization condition conflict",
        operation: "transact-write",
        reason: "conflict",
        table: "execution",
      });
    }
  }
  if (
    operation.table === "execution" &&
    typeof values?.[":owner"] === "string" &&
    typeof values[":runId"] === "string" &&
    typeof values[":version"] === "number"
  ) {
    if (
      existing?.itemType !== "runtime-lease" ||
      existing.data.owner !== values[":owner"] ||
      existing.data.runId !== values[":runId"] ||
      existing.data.version !== values[":version"]
    ) {
      throw new Error("simulated execution lease condition conflict");
    }
  }
  if (
    operation.table === "execution" &&
    values?.[":canceled"] === "canceled" &&
    typeof values[":attempt"] === "number" &&
    typeof values[":claimedBy"] === "string" &&
    typeof values[":version"] === "number"
  ) {
    if (
      existing?.itemType !== "run" ||
      existing.data.status !== values[":canceled"] ||
      existing.data.attempt !== values[":attempt"] ||
      existing.data.claimedBy !== values[":claimedBy"] ||
      existing.data.version !== values[":version"]
    ) {
      throw new Error("simulated canceled execution condition conflict");
    }
  }
}
