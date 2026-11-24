import { Schema } from "effect";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";

const AppPersistenceFailure = Schema.Literals([
  "app-domain-limit",
  "conflict",
  "domain-claimed",
  "illegal-state",
  "not-found",
  "organization-domain-limit",
  "slug-taken",
  "still-provisioning",
  "txt-not-found",
  "unknown",
]);

export class AppPersistenceError extends Schema.TaggedErrorClass<AppPersistenceError>()(
  "AppPersistenceError",
  {
    cause: Schema.Unknown,
    message: Schema.String,
    operation: Schema.String,
    reason: AppPersistenceFailure,
  },
) {}

export function refuse(
  operation: string,
  reason: Exclude<AppPersistenceError["reason"], "conflict" | "slug-taken" | "unknown">,
  message: string,
): never {
  throw new AppPersistenceError({ cause: message, message, operation, reason });
}

export async function commit(operation: string, write: Promise<void>) {
  try {
    await write;
  } catch (cause) {
    throw new AppPersistenceError({
      cause,
      message: `App ${operation} failed.`,
      operation,
      reason: isDatabaseWriteConflict(cause) ? "conflict" : "unknown",
    });
  }
}
