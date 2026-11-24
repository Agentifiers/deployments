import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  DatabaseError,
  Ulid,
  authorizePlatformHumanScope,
  isDatabaseContention,
  organizationRoleAllows,
  type DynamoDatabaseService,
  type OrganizationAccess,
  type PlatformHumanScopeAuthorizationInput,
} from "@deployments-ai/db";
import {
  AwsNativeMemoryError,
  MemoryPlatformError,
  type MemoryPlatformScope,
} from "@deployments-ai/memory";
import { databaseFailureLogContext } from "./failure-diagnostics.ts";
export interface MemoryApiEvent {
  readonly body?: string | null;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly pathParameters?: Readonly<Record<string, string | undefined>>;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>>;
  readonly rawPath?: string;
  readonly requestContext?: {
    readonly authorizer?: {
      readonly jwt?: { readonly claims?: Readonly<Record<string, string>> };
    };
    readonly http?: { readonly method?: string; readonly path?: string };
    readonly requestId?: string;
  };
}

export class MemoryApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MemoryApiError";
  }
}

export const MAX_SEARCH_SPACE_COUNT = 20;
export const MAX_SEARCH_KEY_COUNT = 50;
const MAX_IMPORT_COUNT = 100;
export const MAX_IMPORT_SERIALIZED_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_PAGE_SIZE = 20;

export function derivedImportIdempotencyKey(idempotencyKey: string, index: number) {
  return createHash("sha256").update(`${idempotencyKey}\0${index}`).digest("hex");
}

export function response(
  statusCode: number,
  value?: unknown,
  requestId = "unknown",
  contentType = "application/json",
) {
  return {
    statusCode,
    headers: {
      "content-type": contentType,
      "x-request-id": requestId,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  };
}

export function parseBody(event: MemoryApiEvent) {
  if (!event.body) return {};
  try {
    const value = JSON.parse(event.body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("body must be an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new MemoryApiError(400, "invalid_json", "Request body must be a JSON object.");
  }
}

export function required(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new MemoryApiError(400, "invalid_request", `${label} is required.`);
  }
  return value.trim();
}

export function ulid(value: unknown, label: string) {
  try {
    return Schema.decodeUnknownSync(Ulid)(required(value, label));
  } catch {
    throw new MemoryApiError(400, "invalid_id", `${label} must be a canonical ULID.`);
  }
}

export function optionalUlid(value: unknown, label: string) {
  return value === undefined ? undefined : ulid(value, label);
}

export function stringArray(value: unknown, label: string, maxLength?: number) {
  if (!Array.isArray(value)) {
    throw new MemoryApiError(400, "invalid_request", `${label} must be a string array.`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new MemoryApiError(
      400,
      "invalid_request",
      `${label} accepts at most ${maxLength} entries.`,
    );
  }
  if (value.some((entry) => typeof entry !== "string")) {
    throw new MemoryApiError(400, "invalid_request", `${label} must be a string array.`);
  }
  return value as string[];
}

function optionalString(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new MemoryApiError(400, "invalid_request", `${label} must be a string.`);
  }
  return value;
}

function optionalIdempotencyKey(value: unknown, label: string) {
  const candidate = optionalString(value, label);
  if (candidate === undefined) return undefined;
  const normalized = candidate.trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > 500) {
    throw new MemoryApiError(
      400,
      "invalid_idempotency_key",
      `${label} must contain between 1 and 500 UTF-8 bytes.`,
    );
  }
  return normalized;
}

export function optionalRecord(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryApiError(400, "invalid_request", `${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function oneOf<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  const normalized = required(value, label);
  if (!allowed.includes(normalized)) {
    throw new MemoryApiError(
      400,
      "invalid_request",
      `${label} must be one of ${allowed.join(", ")}.`,
    );
  }
  return normalized as T[number];
}

export function optionalOneOf<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] | undefined {
  return value === undefined ? undefined : oneOf(value, label, allowed);
}

export function optionalBoolean(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new MemoryApiError(400, "invalid_request", `${label} must be a boolean.`);
  }
  return value;
}

export function optionalNumber(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MemoryApiError(400, "invalid_request", `${label} must be a number.`);
  }
  return value;
}

export function optionalLimit(value: unknown, label = "limit", maximum = 200) {
  if (value === undefined) return undefined;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new MemoryApiError(
      400,
      "invalid_request",
      `${label} must be an integer from 1 to ${maximum}.`,
    );
  }
  return parsed;
}

export function optionalQualityLimit(value: unknown) {
  if (value === undefined) return undefined;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 5_000) {
    throw new MemoryApiError(400, "invalid_request", "limit must be an integer from 1 to 5000.");
  }
  return parsed;
}

export function paginationInput(cursor: unknown, limit: unknown) {
  const normalizedCursor = optionalString(cursor, "cursor")?.trim();
  if (normalizedCursor !== undefined && !normalizedCursor) {
    throw new MemoryApiError(400, "invalid_cursor", "cursor must not be empty.");
  }
  const normalizedLimit = optionalLimit(limit);
  return {
    ...(normalizedCursor ? { cursor: normalizedCursor } : {}),
    ...(normalizedLimit === undefined ? {} : { limit: normalizedLimit }),
  };
}

export function memoryPaginationInput(cursor: unknown, limit: unknown) {
  const pagination = paginationInput(cursor, limit);
  return {
    ...pagination,
    limit: Math.min(pagination.limit ?? MAX_MEMORY_PAGE_SIZE, MAX_MEMORY_PAGE_SIZE),
  };
}

export function importItems(value: unknown) {
  if (!Array.isArray(value)) {
    throw new MemoryApiError(400, "invalid_import", "data must be an array.");
  }
  if (value.length < 1 || value.length > MAX_IMPORT_COUNT) {
    throw new MemoryApiError(
      400,
      "invalid_import",
      `data must contain between 1 and ${MAX_IMPORT_COUNT} items.`,
    );
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_IMPORT_SERIALIZED_BYTES) {
    throw new MemoryApiError(
      400,
      "invalid_import",
      `data must serialize to at most ${MAX_IMPORT_SERIALIZED_BYTES} bytes.`,
    );
  }
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new MemoryApiError(400, "invalid_import", `data[${index}] must be an object.`);
    }
    const item = candidate as Record<string, unknown>;
    if (
      item.brainProvenance !== undefined ||
      item.source !== undefined ||
      item.sourceRunId !== undefined
    ) {
      throw new MemoryApiError(
        400,
        "invalid_import",
        `data[${index}] source provenance is assigned by the memory service.`,
      );
    }
    const scope = required(item.scope, `data[${index}].scope`);
    const idempotencyKey = optionalIdempotencyKey(
      item.idempotencyKey,
      `data[${index}].idempotencyKey`,
    );
    const metadata = optionalRecord(item.metadata, `data[${index}].metadata`);
    const entityKeys =
      item.entityKeys === undefined
        ? undefined
        : stringArray(item.entityKeys, `data[${index}].entityKeys`, 20).map((value, entityIndex) =>
            required(value, `data[${index}].entityKeys[${entityIndex}]`),
          );
    const importance = optionalNumber(item.importance, `data[${index}].importance`);
    const sourceQuality = optionalNumber(item.sourceQuality, `data[${index}].sourceQuality`);
    const supersedesMemoryId = optionalUlid(
      item.supersedesMemoryId,
      `data[${index}].supersedesMemoryId`,
    );
    const validFrom = optionalString(item.validFrom, `data[${index}].validFrom`);
    const validUntil = optionalString(item.validUntil, `data[${index}].validUntil`);
    const searchKey = optionalString(item.searchKey, `data[${index}].searchKey`);
    if (!["agent", "organization", "thread", "workspace"].includes(scope)) {
      throw new MemoryApiError(400, "invalid_import", `data[${index}].scope is invalid.`);
    }
    return {
      ...(typeof item.agentDefinitionId === "string"
        ? {
            agentDefinitionId: ulid(item.agentDefinitionId, `data[${index}].agentDefinitionId`),
          }
        : {}),
      content: required(item.content, `data[${index}].content`),
      ...(entityKeys === undefined ? {} : { entityKeys }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(importance === undefined ? {} : { importance }),
      ...(item.memoryType === undefined
        ? {}
        : {
            memoryType: oneOf(item.memoryType, `data[${index}].memoryType`, [
              "episode",
              "fact",
              "preference",
              "procedure",
              "summary",
            ]),
          }),
      ...(metadata === undefined ? {} : { metadata }),
      scope: scope as "agent" | "organization" | "thread" | "workspace",
      ...(searchKey === undefined ? {} : { searchKey }),
      ...(sourceQuality === undefined ? {} : { sourceQuality }),
      ...(supersedesMemoryId ? { supersedesMemoryId } : {}),
      ...(typeof item.threadId === "string"
        ? { threadId: ulid(item.threadId, `data[${index}].threadId`) }
        : {}),
      ...(typeof item.workspaceId === "string"
        ? { workspaceId: ulid(item.workspaceId, `data[${index}].workspaceId`) }
        : {}),
      ...(validFrom === undefined
        ? {}
        : { validFrom: required(validFrom, `data[${index}].validFrom`) }),
      ...(validUntil === undefined
        ? {}
        : { validUntil: required(validUntil, `data[${index}].validUntil`) }),
    };
  });
}

function requestHeader(event: MemoryApiEvent, name: string) {
  return Object.entries(event.headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === name,
  )?.[1];
}

function claim(claims: Readonly<Record<string, string>> | undefined, name: string) {
  return claims?.[name] ?? claims?.[`custom:${name}`];
}

export interface AuthenticatedMemoryScope extends MemoryPlatformScope {
  readonly organizationRole?: "admin" | "billing" | "member" | "owner" | "viewer";
  readonly platformAdministrator?: boolean;
}

export type PlatformScopeAuthorizer = (
  input: PlatformHumanScopeAuthorizationInput,
) => Promise<OrganizationAccess>;

export function platformScopeAuthorizer(database: DynamoDatabaseService): PlatformScopeAuthorizer {
  return (input) => authorizePlatformHumanScope(database, input);
}

export async function scope(
  event: MemoryApiEvent,
  authorizePlatformScope?: PlatformScopeAuthorizer,
): Promise<AuthenticatedMemoryScope> {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (claims?.client_id) {
    const principalId = claims.sub;
    const organizationId = requestHeader(event, "x-deployments-organization");
    const projectId = requestHeader(event, "x-deployments-project");
    const environmentId = requestHeader(event, "x-deployments-environment");
    if (
      !principalId ||
      !organizationId ||
      !projectId ||
      !environmentId ||
      !authorizePlatformScope
    ) {
      throw new MemoryApiError(
        401,
        "unauthorized",
        "Platform access tokens require live tenant authorization.",
      );
    }
    const parsed = {
      environmentId: ulid(environmentId, "x-deployments-environment header"),
      organizationId: ulid(organizationId, "x-deployments-organization header"),
      principalId: ulid(principalId, "sub claim"),
      projectId: ulid(projectId, "x-deployments-project header"),
    };
    const tokenSessionId = claims.sid;
    const access = await authorizePlatformScope({
      ...parsed,
      ...(Schema.is(Ulid)(tokenSessionId) ? { tokenSessionId } : {}),
    });
    switch (access.kind) {
      case "denied":
        throw new MemoryApiError(
          403,
          "tenant_forbidden",
          "The requested tenant is not authorized.",
        );
      case "sso-required":
        throw new MemoryApiError(
          403,
          "organization_sso_required",
          "The organization requires single sign-on.",
        );
      case "operator-access-required":
        throw new MemoryApiError(
          403,
          "operator_access_required",
          "Platform administrators need open operator access to this organization.",
        );
      case "member":
        return { ...parsed, organizationRole: access.role, platformAdministrator: false };
      case "platform-administrator":
        return {
          ...parsed,
          operatorAccessGrantId: access.operatorAccess.grantId,
          platformAdministrator: true,
        };
    }
  }
  const organizationId = claim(claims, "organization_id");
  const projectId = claim(claims, "project_id");
  const environmentId = claim(claims, "environment_id");
  const principalId = claim(claims, "principal_id");
  const workspaceId = claim(claims, "workspace_id");
  if (!organizationId || !projectId || !environmentId) {
    throw new MemoryApiError(401, "unauthorized", "Tenant JWT claims are required.");
  }
  const tenant = {
    environmentId: ulid(environmentId, "environment_id claim"),
    organizationId: ulid(organizationId, "organization_id claim"),
    projectId: ulid(projectId, "project_id claim"),
    ...(principalId ? { principalId: ulid(principalId, "principal_id claim") } : {}),
    ...(workspaceId
      ? {
          exactWorkspaceMutations: true,
          workspaceId: ulid(workspaceId, "workspace_id claim"),
        }
      : {}),
  };
  for (const [header, expected] of [
    ["x-deployments-organization", tenant.organizationId],
    ["x-deployments-project", tenant.projectId],
    ["x-deployments-environment", tenant.environmentId],
  ] as const) {
    const supplied = requestHeader(event, header);
    if (supplied !== undefined && supplied !== expected) {
      throw new MemoryApiError(
        403,
        "tenant_context_mismatch",
        `${header} does not match the authenticated tenant.`,
      );
    }
  }
  return tenant;
}

type MemoryCapability = "memory:admin" | "memory:execute" | "memory:read" | "memory:write";

function claimCapabilities(event: MemoryApiEvent) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const values = [claim(claims, "scope"), claims?.scp, claims?.permissions, claims?.capabilities];
  const capabilities = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) if (typeof entry === "string") capabilities.add(entry);
        continue;
      }
    } catch {
      // Space- and comma-delimited claims are the common JWT scope representation.
    }
    for (const entry of value.split(/[\s,]+/u)) if (entry) capabilities.add(entry);
  }
  return capabilities;
}

function requiredCapability(path: string, method: string): MemoryCapability {
  if (
    path === "/v1/memory/active-recall" ||
    path === "/v1/memory/flushes" ||
    path.startsWith("/v1/memory/flushes/")
  ) {
    return "memory:execute";
  }
  if (
    (path === "/v1/memory/policies" && method !== "GET") ||
    (path === "/v1/memory" && method === "GET") ||
    path === "/v1/memory-space-grants" ||
    path.startsWith("/v1/memory-space-grants/") ||
    (path === "/v1/memory-spaces" && method === "POST") ||
    (path.startsWith("/v1/memory-spaces/") && method === "DELETE") ||
    path === "/v1/memory/exports" ||
    path.startsWith("/v1/memory/evidence/") ||
    path.startsWith("/v1/memory/namespaces/") ||
    path === "/v1/memory/review-items" ||
    /\/review(?:-items\/[^/]+)?$/u.test(path) ||
    /\/(?:archive|delete|restore)$/u.test(path)
  ) {
    return "memory:admin";
  }
  if (path === "/v1/memory/imports" || path.endsWith("/feedback")) {
    return "memory:write";
  }
  return "memory:read";
}

export function authorize(
  event: MemoryApiEvent,
  path: string,
  method: string,
  tenant?: AuthenticatedMemoryScope,
) {
  const required = requiredCapability(path, method);
  const capabilities = claimCapabilities(event);
  const platformAccessToken = Boolean(event.requestContext?.authorizer?.jwt?.claims?.client_id);
  const allowed =
    required === "memory:execute"
      ? capabilities.has("memory:execute") ||
        (!platformAccessToken && capabilities.has("memory:admin"))
      : capabilities.has("memory:admin") ||
        (required === "memory:write" && capabilities.has("memory:write")) ||
        (required === "memory:read" && capabilities.has("memory:read"));
  if (!allowed) {
    throw new MemoryApiError(403, "forbidden", `${required} capability is required.`);
  }
  if (
    platformAccessToken &&
    required !== "memory:read" &&
    !tenant?.platformAdministrator &&
    !organizationRoleAllows(tenant?.organizationRole, "resources.mutate")
  ) {
    throw new MemoryApiError(
      403,
      "insufficient_role",
      "Memory mutations require an organization owner or administrator.",
    );
  }
}

export function authorizeRun(
  event: MemoryApiEvent,
  runId: string,
  tenant?: AuthenticatedMemoryScope,
) {
  const claimedRunId = claim(event.requestContext?.authorizer?.jwt?.claims, "run_id");
  if (!claimedRunId && tenant?.platformAdministrator) return;
  if (!claimedRunId) {
    throw new MemoryApiError(
      403,
      "run_bound_token_required",
      "This operation requires a token bound to the requested run.",
    );
  }
  if (ulid(claimedRunId, "run_id claim") !== runId) {
    throw new MemoryApiError(403, "run_forbidden", "The token is bound to a different run.");
  }
}

function databaseRequestTimedOut(cause: unknown) {
  if (!(cause instanceof DatabaseError)) return false;
  const nested = cause.cause;
  return (
    nested instanceof Error && (nested.name === "AbortError" || nested.name === "TimeoutError")
  );
}

function awsNativeRequestTimedOut(cause: unknown) {
  if (!(cause instanceof AwsNativeMemoryError)) return false;
  const nested = cause.cause;
  return (
    nested instanceof Error && (nested.name === "AbortError" || nested.name === "TimeoutError")
  );
}

function awsNativeFailureLogContext(cause: unknown) {
  if (!(cause instanceof AwsNativeMemoryError)) return {};
  const nested = cause.cause;
  const status =
    nested &&
    typeof nested === "object" &&
    Number.isSafeInteger((nested as { status?: unknown }).status)
      ? (nested as { status: number }).status
      : undefined;
  const details =
    nested && typeof nested === "object" ? (nested as { details?: unknown }).details : undefined;
  const providerError =
    (cause.operation === "prepare-open-search-index" ||
      cause.operation === "prepare-open-search-replicas" ||
      cause.operation === "validate-existing-open-search-index" ||
      cause.operation === "validate-open-search-readiness") &&
    details &&
    typeof details === "object" &&
    (details as { error?: unknown }).error &&
    typeof (details as { error: unknown }).error === "object"
      ? (details as { error: Readonly<Record<string, unknown>> }).error
      : undefined;
  const providerErrorType =
    typeof providerError?.type === "string" ? providerError.type.slice(0, 128) : undefined;
  const providerErrorReason =
    typeof providerError?.reason === "string" ? providerError.reason.slice(0, 512) : undefined;
  return {
    providerOperation: cause.operation,
    ...(providerErrorReason === undefined ? {} : { providerErrorReason }),
    ...(providerErrorType === undefined ? {} : { providerErrorType }),
    ...(status === undefined ? {} : { providerStatus: status }),
  };
}

export function problem(cause: unknown, requestId: string) {
  const error =
    cause instanceof MemoryApiError
      ? cause
      : cause instanceof MemoryPlatformError
        ? new MemoryApiError(cause.statusCode, cause.code, cause.message)
        : (cause instanceof Error && cause.name === "TimeoutError") ||
            databaseRequestTimedOut(cause) ||
            awsNativeRequestTimedOut(cause)
          ? new MemoryApiError(504, "memory_timeout", "Memory request timed out.")
          : isDatabaseContention(cause)
            ? new MemoryApiError(503, "memory_busy", "Memory is busy. Retry the request.")
            : new MemoryApiError(500, "memory_internal_error", "Memory request failed.");
  if (error.statusCode >= 500) {
    console.error("Memory API request failed.", {
      ...(cause instanceof DatabaseError
        ? {
            ...databaseFailureLogContext(cause),
            errorMessage: cause.message,
          }
        : {}),
      ...awsNativeFailureLogContext(cause),
      errorType: cause instanceof Error ? cause.name : "UnknownError",
      requestId,
    });
  }
  const result = response(
    error.statusCode,
    {
      code: error.code,
      detail: error.message,
      requestId,
      status: error.statusCode,
      title: error.statusCode >= 500 ? "Memory request failed" : "Invalid memory request",
      type: `urn:deployments-ai:memory:${error.code}`,
    },
    requestId,
    "application/problem+json",
  );
  return error.code === "memory_busy"
    ? { ...result, headers: { ...result.headers, "retry-after": "1" } }
    : result;
}

export function routePath(event: MemoryApiEvent) {
  return event.rawPath ?? event.requestContext?.http?.path ?? "/";
}

export function mutationIdempotencyKey(event: MemoryApiEvent, tenant: MemoryPlatformScope) {
  const value = Object.entries(event.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "idempotency-key",
  )?.[1];
  if (value === undefined) return undefined;
  const normalized = optionalIdempotencyKey(value, "Idempotency-Key");
  if (!normalized) return undefined;
  const scopedKey = `${tenant.projectId}:${tenant.environmentId}:${normalized}`;
  const encodedKey = `IDEMPOTENCY#${encodeURIComponent(scopedKey)}`;
  if (new TextEncoder().encode(encodedKey).byteLength > 1_024) {
    throw new MemoryApiError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key is too large after canonical encoding.",
    );
  }
  return normalized;
}
