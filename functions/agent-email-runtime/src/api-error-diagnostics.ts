import { AgentEmailPlacementProviderError } from "@deployments-ai/agent-email/aws";
import { AgentEmailPersistenceError, DatabaseError } from "@deployments-ai/db";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function accessDeniedDiagnostics(cause: unknown) {
  const value = record(cause);
  const causeName = cause instanceof Error ? cause.name : value?.name;
  if (causeName !== "AccessDeniedException") return {};
  const rawMessage = cause instanceof Error ? cause.message : value?.message;
  if (typeof rawMessage !== "string") return { databaseAccessDeniedReason: "unknown" };
  const message = rawMessage.slice(0, 4096);
  const assumedRole = message.match(/assumed-role\/([A-Za-z0-9+=,.@_-]{1,64})\//u)?.[1];
  // DynamoDB can surface a downstream table-CMK denial as the cause of its
  // AccessDeniedException, so this database error chain deliberately accepts
  // only DynamoDB and KMS authorization metadata.
  const deniedAction = message.match(/\b((?:dynamodb|kms):[A-Za-z][A-Za-z0-9*]{0,63})\b/u)?.[1];
  const deniedDynamoResource = message.match(
    /\b(arn:aws[a-z-]*:dynamodb:[a-z0-9-]{1,32}:[0-9]{12}:table\/[A-Za-z0-9_.-]{3,255}(?:\/index\/[A-Za-z0-9_.-]{3,255})?)\b/u,
  )?.[1];
  const deniedKmsResource = message.match(
    /\b(arn:aws[a-z-]*:kms:[a-z0-9-]{1,32}:[0-9]{12}:key\/[0-9a-f-]{36})\b/u,
  )?.[1];
  const deniedResource = deniedDynamoResource ?? deniedKmsResource;
  const normalized = message.toLowerCase();
  const databaseAccessDeniedReason = normalized.includes("no identity-based policy allows")
    ? "missing_identity_permission"
    : normalized.includes("service control policy")
      ? "service_control_policy"
      : normalized.includes("permissions boundary")
        ? "permissions_boundary"
        : normalized.includes("session policy")
          ? "session_policy"
          : normalized.includes("vpc endpoint policy")
            ? "vpc_endpoint_policy"
            : normalized.includes("resource-based policy")
              ? "resource_policy"
              : "unknown";
  return {
    databaseAccessDeniedReason,
    ...(assumedRole ? { databaseAssumedRole: assumedRole } : {}),
    ...(deniedAction ? { databaseDeniedAction: deniedAction } : {}),
    ...(deniedResource ? { databaseDeniedResource: deniedResource } : {}),
  };
}

export function logAgentEmailApiFailure(cause: unknown, requestId: string) {
  const failure = cause instanceof AgentEmailPersistenceError ? cause.cause : cause;
  const nestedCause = failure instanceof DatabaseError ? failure.cause : cause;
  const nestedRecord = record(nestedCause);
  const providerCause =
    failure instanceof AgentEmailPlacementProviderError ? failure.cause : nestedCause;
  const providerRecord = record(providerCause);
  const providerMetadata = record(providerRecord?.$metadata);
  const cancellationReasons = Array.isArray(nestedRecord?.CancellationReasons)
    ? nestedRecord.CancellationReasons.flatMap((reason) => {
        const value = record(reason);
        return typeof value?.Code === "string" ? [value.Code] : [];
      })
    : [];
  console.error("Agent Email API request failed.", {
    ...(failure instanceof DatabaseError
      ? {
          databaseCauseType:
            nestedCause instanceof Error
              ? nestedCause.name
              : typeof nestedRecord?.name === "string"
                ? nestedRecord.name
                : "UnknownError",
          ...(cancellationReasons.length > 0
            ? { databaseCancellationCodes: cancellationReasons }
            : {}),
          databaseOperation: failure.operation,
          databaseReason: failure.reason,
          databaseTable: failure.table,
          ...accessDeniedDiagnostics(nestedCause),
        }
      : {}),
    errorType: failure instanceof Error ? failure.name : "UnknownError",
    ...(failure instanceof AgentEmailPlacementProviderError
      ? {
          placementOperation: failure.operation,
          providerErrorType:
            providerCause instanceof Error
              ? providerCause.name
              : typeof providerRecord?.name === "string"
                ? providerRecord.name
                : "UnknownError",
        }
      : {}),
    providerStatusCode:
      typeof providerMetadata?.httpStatusCode === "number"
        ? providerMetadata.httpStatusCode
        : undefined,
    requestId,
  });
}
