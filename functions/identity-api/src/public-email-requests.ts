import { Ulid, type Ulid as UlidType } from "@deployments-ai/db";
import { Schema } from "effect";
import type { IdentityApplication } from "./application.ts";

export interface PublicEmailRequest {
  readonly email: string;
  readonly operation: "password-recovery" | "sign-up";
  readonly requestId: UlidType;
  readonly schemaVersion: 1;
  readonly sourcePrefixHash?: string;
}

export interface QueuedPublicEmailRequest extends Omit<
  PublicEmailRequest,
  "requestId" | "schemaVersion"
> {
  readonly sourcePrefixHash?: string;
}

function decodePublicEmailRequest(value: string): PublicEmailRequest {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Public email request must be an object.");
  }
  const request = parsed as Record<string, unknown>;
  if (
    request.schemaVersion !== 1 ||
    typeof request.email !== "string" ||
    !request.email ||
    (request.sourcePrefixHash !== undefined &&
      (typeof request.sourcePrefixHash !== "string" || !request.sourcePrefixHash)) ||
    (request.operation !== "password-recovery" && request.operation !== "sign-up") ||
    Object.keys(request).some(
      (key) =>
        !["email", "operation", "requestId", "schemaVersion", "sourcePrefixHash"].includes(key),
    )
  ) {
    throw new Error("Public email request is invalid.");
  }
  return {
    email: request.email,
    operation: request.operation,
    requestId: Schema.decodeUnknownSync(Ulid)(request.requestId),
    schemaVersion: 1,
    ...(typeof request.sourcePrefixHash === "string"
      ? { sourcePrefixHash: request.sourcePrefixHash }
      : {}),
  };
}

export function makePublicEmailRequestProcessor(application: IdentityApplication) {
  return async (event: {
    readonly Records?: readonly { readonly body?: string; readonly messageId?: string }[];
  }) => {
    const failures: { itemIdentifier: string }[] = [];
    for (const record of event.Records ?? []) {
      try {
        const request = decodePublicEmailRequest(record.body ?? "");
        if (request.operation === "sign-up") {
          await application.signUp(request.email, request.sourcePrefixHash, request.requestId);
        } else {
          await application.forgotPassword(
            request.email,
            request.sourcePrefixHash,
            request.requestId,
          );
        }
      } catch {
        if (record.messageId) failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}
