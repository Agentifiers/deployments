import { createHash, createHmac, timingSafeEqual } from "node:crypto";

interface ThreadHistoryCursorScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly threadId: string;
}

const THREAD_HISTORY_CURSOR_DOMAIN = "deployments-ai:thread-history-cursor:v1";

export function credentialHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function exactHash(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function threadHistoryCursorSignature(
  cursor: string,
  scope: ThreadHistoryCursorScope,
  secret: string,
) {
  return createHmac("sha256", secret)
    .update(
      [
        THREAD_HISTORY_CURSOR_DOMAIN,
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        scope.threadId,
        cursor,
      ].join("\u0000"),
    )
    .digest("base64url");
}

export function signThreadHistoryCursor(
  cursor: string,
  scope: ThreadHistoryCursorScope,
  secret: string,
) {
  return `${cursor}.${threadHistoryCursorSignature(cursor, scope, secret)}`;
}

export function verifyThreadHistoryCursor(
  token: string,
  scope: ThreadHistoryCursorScope,
  secret: string,
): string | undefined {
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return undefined;
  const cursor = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor) || !/^[A-Za-z0-9_-]{43}$/u.test(signature)) {
    return undefined;
  }
  const expected = threadHistoryCursorSignature(cursor, scope, secret);
  return exactHash(signature, expected) ? cursor : undefined;
}
