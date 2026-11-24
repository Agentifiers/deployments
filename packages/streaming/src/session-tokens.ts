import { createHmac, timingSafeEqual } from "node:crypto";
import { StreamContractError, StreamSessionExpiredError } from "./errors.ts";
import type { ThreadStreamSessionClaims } from "./sessions.ts";

export interface ThreadStreamSessionTokenOptions {
  readonly audience?: string;
  readonly issuer?: string;
  readonly secret: string | Uint8Array;
}

const TOKEN_VERSION = "dss1";
const MIN_SECRET_BYTES = 32;

function secretBytes(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new StreamContractError(
      "sessionToken.secret",
      `Stream session token secrets must contain at least ${MIN_SECRET_BYTES} bytes.`,
    );
  }
  return bytes;
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value: string, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new StreamContractError(label, `${label} is invalid.`);
  }
}

function signature(payload: string, secret: Uint8Array) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function requiredString(record: Readonly<Record<string, unknown>>, field: string) {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new StreamContractError(`sessionToken.${field}`, `sessionToken.${field} is required.`);
  }
  return value.trim();
}

function claims(value: unknown, options: Omit<ThreadStreamSessionTokenOptions, "secret">) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StreamContractError(
      "sessionToken.payload",
      "Stream session token payload is invalid.",
    );
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record.version !== 1) {
    throw new StreamContractError(
      "sessionToken.version",
      "Stream session token version is unsupported.",
    );
  }
  if (options.audience && record.audience !== options.audience) {
    throw new StreamContractError(
      "sessionToken.audience",
      "Stream session token audience does not match.",
    );
  }
  if (options.issuer && record.issuer !== options.issuer) {
    throw new StreamContractError(
      "sessionToken.issuer",
      "Stream session token issuer does not match.",
    );
  }
  if (
    !Array.isArray(record.permissions) ||
    record.permissions.length === 0 ||
    record.permissions.some((permission) => permission !== "append" && permission !== "read")
  ) {
    throw new StreamContractError(
      "sessionToken.permissions",
      "Stream session token permissions are invalid.",
    );
  }
  return {
    environmentId: requiredString(record, "environmentId"),
    expiresAt: requiredString(record, "expiresAt"),
    organizationId: requiredString(record, "organizationId"),
    permissions: [...new Set(record.permissions)] as readonly ("append" | "read")[],
    projectId: requiredString(record, "projectId"),
    sessionId: requiredString(record, "sessionId"),
    threadId: requiredString(record, "threadId"),
  } satisfies ThreadStreamSessionClaims;
}

export function signThreadStreamSessionToken(
  session: ThreadStreamSessionClaims,
  options: ThreadStreamSessionTokenOptions,
) {
  const payload = encode({
    ...(options.audience ? { audience: options.audience } : {}),
    environmentId: session.environmentId,
    expiresAt: session.expiresAt,
    ...(options.issuer ? { issuer: options.issuer } : {}),
    organizationId: session.organizationId,
    permissions: [...new Set(session.permissions)].toSorted(),
    projectId: session.projectId,
    sessionId: session.sessionId,
    threadId: session.threadId,
    version: 1,
  });
  const signed = `${TOKEN_VERSION}.${payload}`;
  return `${signed}.${signature(signed, secretBytes(options.secret))}`;
}

export function verifyThreadStreamSessionToken(
  token: string,
  options: ThreadStreamSessionTokenOptions & { readonly now?: number },
): ThreadStreamSessionClaims {
  const [version, payload, providedSignature, extra] = token.split(".");
  if (version !== TOKEN_VERSION || !payload || !providedSignature || extra !== undefined) {
    throw new StreamContractError("sessionToken", "Stream session token is invalid.");
  }
  const signed = `${version}.${payload}`;
  const expected = Buffer.from(signature(signed, secretBytes(options.secret)), "utf8");
  const provided = Buffer.from(providedSignature, "utf8");
  if (expected.byteLength !== provided.byteLength || !timingSafeEqual(expected, provided)) {
    throw new StreamContractError(
      "sessionToken.signature",
      "Stream session token signature is invalid.",
    );
  }
  const parsed = claims(decode(payload, "sessionToken.payload"), options);
  const expiration = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(expiration)) {
    throw new StreamContractError(
      "sessionToken.expiresAt",
      "Stream session expiration is invalid.",
    );
  }
  if (expiration <= (options.now ?? Date.now())) {
    throw new StreamSessionExpiredError(parsed.expiresAt);
  }
  return parsed;
}
