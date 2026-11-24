import { DatabaseError } from "@deployments-ai/db";

function databaseCancellationCodes(error: DatabaseError): readonly string[] | undefined {
  if (!error.cause || typeof error.cause !== "object") return undefined;
  const cause = error.cause as Readonly<Record<string, unknown>>;
  const reasons = cause.CancellationReasons ?? cause.cancellationReasons;
  if (!Array.isArray(reasons) || reasons.length === 0) return undefined;
  return reasons.map((reason) => {
    if (!reason || typeof reason !== "object") return "Unknown";
    const candidate = reason as Readonly<Record<string, unknown>>;
    const code = candidate.Code ?? candidate.code ?? candidate.name;
    return typeof code === "string" ? code : "Unknown";
  });
}

function databaseCauseType(error: DatabaseError): string | undefined {
  if (!error.cause || typeof error.cause !== "object") return undefined;
  const cause = error.cause as Readonly<Record<string, unknown>>;
  for (const candidate of [cause._tag, cause.name, cause.Code, cause.code]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

export function databaseFailureLogContext(cause: unknown) {
  if (!(cause instanceof DatabaseError)) return {};
  const cancellationCodes = databaseCancellationCodes(cause);
  const causeType = databaseCauseType(cause);
  return {
    ...(cancellationCodes ? { databaseCancellationCodes: cancellationCodes } : {}),
    ...(causeType ? { databaseCauseType: causeType } : {}),
    databaseOperation: cause.operation,
    ...(cause.reason ? { databaseReason: cause.reason } : {}),
    databaseTable: cause.table,
  };
}
