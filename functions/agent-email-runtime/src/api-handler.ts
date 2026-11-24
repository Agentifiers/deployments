import {
  AgentEmailPersistenceError,
  DatabaseError,
  EmailPersistenceError,
  PersistenceError,
  recordApiCredentialUsageBestEffort,
  type ApiCredentialUsageInput,
  type ApiCredentialUsageRecorder,
} from "@deployments-ai/db";
import { createHash, randomUUID } from "node:crypto";
import {
  organizationRefusalResult,
  routeActivity,
  type OrganizationGate,
} from "@deployments-ai/organization-admission";
import { logAgentEmailApiFailure } from "./api-error-diagnostics.ts";
import { AgentEmailApiError } from "./api-errors.ts";
import { AGENT_EMAIL_API_ROUTES, EMAIL_API_ROUTES, type EmailApiOperation } from "./api-routes.ts";

export { AgentEmailApiError } from "./api-errors.ts";
export { AGENT_EMAIL_API_ROUTES } from "./api-routes.ts";

export type AgentEmailApiPermission =
  | "agent-email:admin"
  | "agent-email:read"
  | "agent-email:write"
  | "email:admin"
  | "email:read"
  | "email:write";

export interface AgentEmailApiScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

export interface AgentEmailApiIdentity {
  readonly apiCredentialId?: string;
  readonly authentication?: "api-credential" | "tenant-jwt";
  readonly permissions: readonly string[];
  readonly principalId: string;
  readonly scope: AgentEmailApiScope;
}

export interface AgentEmailHttpEvent {
  readonly body?: string | null;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly isBase64Encoded?: boolean;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly rawPath: string;
  readonly requestContext?: {
    readonly http?: {
      readonly method?: string;
    };
    readonly requestId?: string;
  };
}

export interface AgentEmailHttpResult {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly statusCode: number;
}

export type AgentEmailApiOperation =
  | EmailApiOperation
  | "approveDraft"
  | "cancelDraft"
  | "createAttachmentAccessUrl"
  | "createBinding"
  | "createDomain"
  | "createDraft"
  | "createInbox"
  | "createPlacement"
  | "createRawMessageAccess"
  | "createSuppression"
  | "deleteBinding"
  | "exportUsage"
  | "forwardMessage"
  | "getDomain"
  | "getBinding"
  | "getDraft"
  | "getInbox"
  | "getInboxThread"
  | "getMessage"
  | "getPlacement"
  | "getPolicy"
  | "getUsage"
  | "listDomains"
  | "listBindings"
  | "listInboxDrafts"
  | "listInboxMessages"
  | "listInboxes"
  | "listInboxThreads"
  | "listPlacements"
  | "listSuppressions"
  | "refreshDomain"
  | "rejectDraft"
  | "removeSuppression"
  | "replyAllMessage"
  | "replyMessage"
  | "reprocessRawMessage"
  | "revokeDomain"
  | "searchInboxMessages"
  | "searchInboxThreads"
  | "sendDraft"
  | "sendInboxMessage"
  | "submitDraft"
  | "updateDraft"
  | "updateInbox"
  | "updatePlacement"
  | "updatePolicy";

export interface AgentEmailApiInvocation {
  readonly body: Readonly<Record<string, unknown>> | undefined;
  readonly idempotencyKey?: string;
  readonly identity: AgentEmailApiIdentity;
  readonly parameters: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, boolean | number | string>>;
  readonly scope: AgentEmailApiScope;
}

export interface AgentEmailApplicationService {
  execute(operation: AgentEmailApiOperation, invocation: AgentEmailApiInvocation): Promise<unknown>;
}

export interface AgentEmailIdempotencyStore {
  execute<T>(input: {
    readonly fingerprint: string;
    readonly key: string;
    readonly operation: () => Promise<T>;
    readonly organizationId: string;
    readonly principalId: string;
  }): Promise<T>;
}

export interface AgentEmailApiDependencies {
  readonly authenticate: (
    event: AgentEmailHttpEvent,
  ) => Promise<AgentEmailApiIdentity | null | undefined>;
  readonly idempotency: AgentEmailIdempotencyStore;
  readonly organizationGate?: OrganizationGate;
  readonly recordApiCredentialUsage?: ApiCredentialUsageRecorder;
  readonly requestId?: () => string;
  readonly service: AgentEmailApplicationService;
}

type BodyMode = "none" | "optional" | "required";

export interface AgentEmailApiRoute {
  readonly body: BodyMode;
  readonly idempotent: boolean;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  readonly operation: AgentEmailApiOperation;
  readonly path: string;
  readonly permission: AgentEmailApiPermission;
  readonly successStatus: 200 | 201 | 202;
}

interface MatchedRoute {
  readonly parameters: Readonly<Record<string, string>>;
  readonly route: AgentEmailApiRoute;
}

function headerMap(event: AgentEmailHttpEvent) {
  return Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function routePattern(path: string) {
  const parameterNames: string[] = [];
  const pattern = path
    .split("/")
    .map((part) => {
      if (!part.startsWith(":")) return part.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      parameterNames.push(part.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { parameterNames, pattern: new RegExp(`^${pattern}/?$`, "u") };
}

const compiledRoutes = [...AGENT_EMAIL_API_ROUTES, ...EMAIL_API_ROUTES].map((route) => ({
  ...routePattern(route.path),
  route,
}));

function decodedPathParameter(value: string, name: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new AgentEmailApiError(400, "invalid_path_parameter", `${name} is malformed.`);
  }
  if (
    !decoded ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    Array.from(decoded).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new AgentEmailApiError(400, "invalid_path_parameter", `${name} is invalid.`);
  }
  return decoded;
}

function matchRoute(method: string, path: string): MatchedRoute | undefined {
  for (const compiled of compiledRoutes) {
    if (compiled.route.method !== method) continue;
    const match = compiled.pattern.exec(path);
    if (!match) continue;
    return {
      parameters: Object.fromEntries(
        compiled.parameterNames.map((name, index) => [
          name,
          decodedPathParameter(match[index + 1]!, name),
        ]),
      ),
      route: compiled.route,
    };
  }
  return undefined;
}

function permits(identity: AgentEmailApiIdentity, permission: AgentEmailApiPermission) {
  return (
    identity.permissions.includes(permission) ||
    (permission.startsWith("agent-email:") && identity.permissions.includes("agent-email:*")) ||
    (permission.startsWith("email:") &&
      (identity.permissions.includes("email:*") || identity.permissions.includes("email:admin"))) ||
    identity.permissions.includes("platform:*") ||
    identity.permissions.includes("platform:admin")
  );
}

function requiredScope(event: AgentEmailHttpEvent, identity: AgentEmailApiIdentity) {
  const requestHeaders = headerMap(event);
  const environmentId = requestHeaders["x-deployments-environment"]?.trim();
  if (!environmentId) {
    throw new AgentEmailApiError(
      400,
      "missing_scope",
      "environmentId scope is required for agent email operations.",
    );
  }
  const assertedOrganizationId = requestHeaders["x-deployments-organization"]?.trim();
  const assertedProjectId = requestHeaders["x-deployments-project"]?.trim();
  if (
    environmentId !== identity.scope.environmentId ||
    (assertedOrganizationId !== undefined &&
      assertedOrganizationId !== identity.scope.organizationId) ||
    (assertedProjectId !== undefined && assertedProjectId !== identity.scope.projectId)
  ) {
    throw new AgentEmailApiError(
      403,
      "environment_scope_violation",
      "The credential cannot access the requested agent email environment.",
    );
  }
  return identity.scope;
}

function rawBody(event: AgentEmailHttpEvent) {
  const value = event.body ?? "";
  return event.isBase64Encoded ? Buffer.from(value, "base64").toString("utf8") : value;
}

function requestBody(event: AgentEmailHttpEvent, mode: BodyMode) {
  const text = rawBody(event);
  if (!text.trim()) {
    if (mode === "required") {
      throw new AgentEmailApiError(400, "invalid_request", "A JSON request body is required.");
    }
    return undefined;
  }
  if (mode === "none") {
    throw new AgentEmailApiError(
      400,
      "unexpected_request_body",
      "This operation does not accept a request body.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentEmailApiError(400, "invalid_json", "The request body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentEmailApiError(
      400,
      "invalid_request",
      "The JSON request body must be an object.",
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requestQuery(event: AgentEmailHttpEvent) {
  const query: Record<string, boolean | number | string> = {};
  for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value === undefined) continue;
    if (name === "limit") {
      if (!/^\d+$/u.test(value)) {
        throw new AgentEmailApiError(
          400,
          "invalid_query",
          "limit must be an integer between 1 and 100.",
        );
      }
      const limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AgentEmailApiError(
          400,
          "invalid_query",
          "limit must be an integer between 1 and 100.",
        );
      }
      query.limit = limit;
      continue;
    }
    if (name === "cursor" && (value.length === 0 || value.length > 4_096)) {
      throw new AgentEmailApiError(
        400,
        "invalid_query",
        "cursor must contain between 1 and 4096 characters.",
      );
    }
    query[name] = value;
  }
  return query;
}

function requiredIdempotencyKey(event: AgentEmailHttpEvent) {
  const key = headerMap(event)["idempotency-key"];
  if (key === undefined || key.length === 0) {
    throw new AgentEmailApiError(
      400,
      "missing_idempotency_key",
      "The idempotency-key header is required for this operation.",
    );
  }
  if (key.length > 512) {
    throw new AgentEmailApiError(
      400,
      "invalid_idempotency_key",
      "Idempotency keys must not exceed 512 characters.",
    );
  }
  return key;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(operation: AgentEmailApiOperation, invocation: AgentEmailApiInvocation) {
  return createHash("sha256")
    .update(
      canonicalJson({
        body: invocation.body ?? null,
        operation,
        parameters: invocation.parameters,
        query: invocation.query,
        scope: invocation.scope,
      }),
    )
    .digest("hex");
}

export async function executeAgentEmailIdempotentOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    const pending = [cause];
    const seen = new Set<unknown>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      if (
        current instanceof PersistenceError &&
        current.kind === "internal" &&
        current.code === "ambiguous_write_outcome"
      ) {
        throw current;
      }
      if (
        current instanceof DatabaseError &&
        current.reason !== "conflict" &&
        ["delete", "put", "transact-write"].includes(current.operation)
      ) {
        throw new PersistenceError(
          "internal",
          "ambiguous_write_outcome",
          "The agent email write outcome is unknown.",
        );
      }
      if (
        current instanceof AgentEmailPersistenceError ||
        current instanceof EmailPersistenceError
      ) {
        pending.push(current.cause);
      } else if (current instanceof AggregateError) {
        pending.push(...current.errors);
      } else if (current instanceof Error && current.cause !== undefined) {
        pending.push(current.cause);
      }
    }
    throw cause;
  }
}

function response(statusCode: number, value: unknown, requestId: string): AgentEmailHttpResult {
  return {
    body: JSON.stringify(value),
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-request-id": requestId,
    },
    statusCode,
  };
}

function problem(cause: unknown, requestId: string): AgentEmailHttpResult {
  const persistenceCause =
    cause instanceof AgentEmailPersistenceError || cause instanceof EmailPersistenceError
      ? cause.cause
      : cause;
  const error =
    cause instanceof AgentEmailApiError
      ? cause
      : cause instanceof EmailPersistenceError && cause.reason === "validation"
        ? new AgentEmailApiError(400, "invalid_request", cause.message)
        : cause instanceof EmailPersistenceError && cause.reason === "conflict"
          ? new AgentEmailApiError(
              409,
              "write_conflict",
              "The email resource changed or is already claimed.",
            )
          : persistenceCause instanceof PersistenceError && persistenceCause.kind === "conflict"
            ? new AgentEmailApiError(409, persistenceCause.code, persistenceCause.message)
            : persistenceCause instanceof DatabaseError && persistenceCause.reason === "conflict"
              ? new AgentEmailApiError(
                  409,
                  "write_conflict",
                  "The agent email resource changed during this request.",
                )
              : new AgentEmailApiError(500, "internal_error", "Internal server error.");
  if (error.status >= 500) {
    logAgentEmailApiFailure(cause, requestId);
  }
  return {
    body: JSON.stringify({
      code: error.code,
      requestId,
      status: error.status,
      title: error.status === 500 ? "Internal server error" : error.message,
      type: `https://docs.deployments.ai/errors/${error.code.replaceAll("_", "-")}`,
    }),
    headers: {
      "cache-control": "no-store",
      "content-type": "application/problem+json",
      "x-request-id": requestId,
    },
    statusCode: error.status,
  };
}

export function createAgentEmailApiHandler(dependencies: AgentEmailApiDependencies) {
  return async (event: AgentEmailHttpEvent): Promise<AgentEmailHttpResult> => {
    const requestId =
      event.requestContext?.requestId ??
      dependencies.requestId?.() ??
      `req_${randomUUID().replaceAll("-", "")}`;
    const method = event.requestContext?.http?.method?.toUpperCase() ?? "GET";
    let credentialUsage: Omit<ApiCredentialUsageInput, "outcome"> | undefined;
    const recordCredentialUsage = async (outcome: ApiCredentialUsageInput["outcome"]) => {
      if (!credentialUsage) return;
      await recordApiCredentialUsageBestEffort(
        dependencies.recordApiCredentialUsage,
        { ...credentialUsage, outcome },
        (error) => {
          console.error("API credential usage recording failed.", {
            error: error instanceof Error ? error.message : "Unknown recorder error.",
          });
        },
      );
    };
    try {
      const matched = matchRoute(method, event.rawPath);
      if (!matched) {
        throw new AgentEmailApiError(
          404,
          "route_not_found",
          "The requested API route does not exist.",
        );
      }
      const identity = await dependencies.authenticate(event);
      if (!identity) {
        throw new AgentEmailApiError(401, "unauthorized", "A valid bearer credential is required.");
      }
      const decision = await dependencies.organizationGate?.admit(
        identity.scope.organizationId,
        routeActivity(matched.route),
      );
      if (decision && decision.kind !== "admitted") {
        return organizationRefusalResult(decision, requestId);
      }
      if (identity.authentication === "api-credential" && identity.apiCredentialId) {
        credentialUsage = {
          apiCredentialId: identity.apiCredentialId,
          ...identity.scope,
          requestMethod: method,
          requestPath: event.rawPath,
        };
      }
      if (!permits(identity, matched.route.permission)) {
        throw new AgentEmailApiError(
          403,
          "insufficient_scope",
          "The credential does not have the required agent email permission.",
        );
      }
      const scope = requiredScope(event, identity);
      const invocation: AgentEmailApiInvocation = {
        body: requestBody(event, matched.route.body),
        identity,
        parameters: matched.parameters,
        query: requestQuery(event),
        scope,
        ...(matched.route.idempotent ? { idempotencyKey: requiredIdempotencyKey(event) } : {}),
      };
      const execute = () => dependencies.service.execute(matched.route.operation, invocation);
      const result = invocation.idempotencyKey
        ? await dependencies.idempotency.execute({
            fingerprint: fingerprint(matched.route.operation, invocation),
            key: invocation.idempotencyKey,
            operation: () => executeAgentEmailIdempotentOperation(execute),
            organizationId: scope.organizationId,
            principalId: identity.principalId,
          })
        : await execute();
      await recordCredentialUsage("allowed");
      return response(matched.route.successStatus, result, requestId);
    } catch (cause) {
      const result = problem(cause, requestId);
      await recordCredentialUsage(
        result.statusCode === 401 || result.statusCode === 403 ? "denied" : "error",
      );
      return result;
    }
  };
}
