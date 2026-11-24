import { createHash, randomUUID } from "node:crypto";
import {
  CreateTenantErasureRequest,
  GOVERNANCE_API_ROUTES,
  GovernanceOperationKind as ContractGovernanceOperationKind,
  GovernanceOperationPageResponse,
  IdempotencyKey,
  OrganizationRetentionPolicyResponse,
  PublicId,
  UpdateOrganizationRetentionPolicyRequest,
} from "@deployments-ai/api-contract";
import {
  GovernanceError,
  type GovernanceOperation,
  type GovernanceOperationKind,
  type GovernanceOperationStatus,
  type GovernanceService,
} from "@deployments-ai/governance";
import {
  PersistenceError,
  operationRoleAction,
  organizationRoleAllows,
  organizationRolesAllowing,
  type TransactionOperation,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { ApiIdentity, IdempotencyStore } from "./index.ts";
import { errorLogFields } from "./error-log-fields.ts";
import { operationResponse } from "./governance-operation-response.ts";
import { persistenceStatus } from "./persistence-error-status.ts";
import { actsUnderOperatorAccess } from "./scope-permissions.ts";

const strict = { onExcessProperty: "error" } as const;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface GovernanceQueueMessage {
  readonly operationId: string;
  readonly organizationId: string;
}

export interface CreateGovernanceApiOptions {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly createDownloadUrl: (input: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
  }) => Promise<{ readonly expiresAt: string; readonly url: string }>;
  readonly dispatchCompletion: (
    operation: GovernanceOperation,
    operatorAccessGrantId: string | undefined,
  ) => readonly TransactionOperation[];
  readonly enqueue: (message: GovernanceQueueMessage) => Promise<void>;
  readonly idempotency: IdempotencyStore;
  readonly requestId?: () => string;
  readonly service: GovernanceService;
}

class GovernanceApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GovernanceApiProblem";
  }
}

function deterministicOperationId(
  organizationId: string,
  kind: GovernanceOperationKind,
  idempotencyKey: string,
  principalId: string,
) {
  const identity =
    kind === "tenant-erasure"
      ? `${organizationId}\u0000${kind}`
      : `${organizationId}\u0000${principalId}\u0000${kind}\u0000${idempotencyKey}`;
  let value = BigInt(`0x${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return encoded;
}

function permits(scopes: readonly string[], required: "governance:read" | "governance:write") {
  return (
    scopes.includes("platform:*") ||
    scopes.includes("platform:admin") ||
    scopes.includes("governance:*") ||
    scopes.includes(required)
  );
}

function erasureOperationMatchesIdentity(
  operation: GovernanceOperation | undefined,
  identity: ApiIdentity,
) {
  return (
    operation?.kind === "tenant-erasure" &&
    operation.requestedByPrincipalId ===
      (operation.status === "completed"
        ? createHash("sha256").update(identity.principalId).digest("hex")
        : identity.principalId)
  );
}

function governanceStatus(error: GovernanceError) {
  if (error.code === "operation_not_found") return 404;
  if (error.code === "invalid_cursor") return 400;
  if (
    error.code === "operation_not_runnable" ||
    error.code === "retention_policy_conflict" ||
    error.code === "tenant_erasure_already_requested" ||
    error.code === "tenant_erasure_in_progress" ||
    error.code === "tenant_artifact_uploads_pending" ||
    error.code === "tenant_governance_busy" ||
    error.code === "tenant_has_active_runs"
  ) {
    return 409;
  }
  return 422;
}

function problem(cause: unknown, requestId: string, route: string) {
  const validation =
    cause instanceof Error &&
    (cause.name.includes("ParseError") || cause.name.includes("SchemaError") || "issue" in cause);
  const status =
    cause instanceof GovernanceApiProblem
      ? cause.status
      : cause instanceof GovernanceError
        ? governanceStatus(cause)
        : cause instanceof PersistenceError
          ? persistenceStatus(cause)
          : validation
            ? 422
            : 500;
  const code =
    cause instanceof GovernanceApiProblem ||
    cause instanceof GovernanceError ||
    cause instanceof PersistenceError
      ? cause.code
      : validation
        ? "validation_failed"
        : "internal_error";
  if (status === 500) {
    console.error("Governance API request failed.", {
      ...errorLogFields(cause),
      code,
      requestId,
      route,
    });
  }
  return Response.json(
    {
      code,
      requestId,
      status,
      title:
        status === 500
          ? "Internal server error"
          : cause instanceof Error
            ? cause.message
            : "Request failed",
      type: `https://docs.deployments.ai/errors/${code.replaceAll("_", "-")}`,
    },
    {
      headers: {
        "content-type": "application/problem+json",
        "x-request-id": requestId,
      },
      status,
    },
  );
}

async function jsonBody(request: Request) {
  const text = await request.text();
  if (!text) {
    throw new GovernanceApiProblem(400, "invalid_request", "A JSON request body is required.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GovernanceApiProblem(400, "invalid_json", "The request body must be valid JSON.");
  }
}

const GOVERNANCE_RESOURCES = [
  "audit-exports",
  "data-exports",
  "erasures",
  "governance-operations",
  "retention-policy",
] as const;

function routeFor(request: Request) {
  const path = new URL(request.url).pathname.split("/").filter(Boolean);
  if (path.length < 4 || path.length > 5 || path[0] !== "v1" || path[1] !== "organizations") {
    return undefined;
  }
  const resource = GOVERNANCE_RESOURCES.find((candidate) => candidate === path[3]);
  if (!resource) return undefined;
  const operationId = path[4];
  const contractPath = `/v1/organizations/:id/${resource}${operationId === undefined ? "" : "/:operationId"}`;
  const operation = GOVERNANCE_API_ROUTES.find(
    (route) => route.method === request.method && route.path === contractPath,
  );
  if (!operation) return undefined;
  return {
    operation: operation.name,
    operationId,
    organizationId: path[2]!,
    resource,
  };
}

const isOperationKind = Schema.is(ContractGovernanceOperationKind);
const OPERATION_STATUSES: readonly GovernanceOperationStatus[] = [
  "canceled",
  "completed",
  "failed",
  "pending",
  "running",
];

function historyQuery(request: Request) {
  const query = new URL(request.url).searchParams;
  const limitText = query.get("limit");
  const limit = limitText === null ? 50 : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new GovernanceApiProblem(400, "invalid_limit", "limit must be an integer from 1 to 100.");
  }
  const kind = query.get("kind") ?? undefined;
  if (kind !== undefined && !isOperationKind(kind)) {
    throw new GovernanceApiProblem(
      400,
      "invalid_query",
      "kind is not a governance operation kind.",
    );
  }
  const status = query.get("status") ?? undefined;
  if (status !== undefined && !OPERATION_STATUSES.includes(status as GovernanceOperationStatus)) {
    throw new GovernanceApiProblem(400, "invalid_query", "status is not a governance job status.");
  }
  const cursor = query.get("cursor") ?? undefined;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 1_024)) {
    throw new GovernanceApiProblem(400, "invalid_cursor", "cursor is invalid.");
  }
  return {
    ...(cursor ? { cursor } : {}),
    ...(kind ? { kind } : {}),
    limit,
    ...(status ? { status: status as GovernanceOperationStatus } : {}),
  };
}

function expectedKind(resource: "audit-exports" | "data-exports" | "erasures") {
  if (resource === "audit-exports") return "audit-export" as const;
  if (resource === "data-exports") return "tenant-export" as const;
  return "tenant-erasure" as const;
}

async function mutation<T>(
  options: CreateGovernanceApiOptions,
  input: {
    readonly body: unknown;
    readonly completionOperations?: (result: T) => readonly TransactionOperation[];
    readonly identity: ApiIdentity;
    readonly idempotencyKey: string;
    readonly operation: () => Promise<T>;
    readonly organizationId: string;
    readonly route: string;
  },
) {
  return options.idempotency.execute({
    ...(input.completionOperations
      ? {
          completionOperations: (result) => input.completionOperations!(result as T),
        }
      : {}),
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify([input.route, input.organizationId, input.identity.principalId, input.body]),
      )
      .digest("hex"),
    key: input.idempotencyKey,
    operation: input.operation,
    organizationId: input.organizationId,
    principalId: input.identity.principalId,
  }) as Promise<T>;
}

export function createGovernanceApiHandler(options: CreateGovernanceApiOptions) {
  return async (request: Request): Promise<Response | undefined> => {
    const route = routeFor(request);
    if (!route) return undefined;
    const requestId = options.requestId?.() ?? `req_${randomUUID()}`;
    try {
      const organizationId = Schema.decodeUnknownSync(PublicId, strict)(route.organizationId);
      const identity = await options.authenticate(request);
      if (!identity) {
        throw new GovernanceApiProblem(
          401,
          "unauthorized",
          "A valid bearer credential is required.",
        );
      }
      const scopeHeader = request.headers.get("x-deployments-organization")?.trim();
      if (!scopeHeader) {
        throw new GovernanceApiProblem(
          400,
          "missing_scope",
          "The organization scope header is required.",
        );
      }
      const headerOrganizationId = Schema.decodeUnknownSync(PublicId, strict)(scopeHeader);
      if (headerOrganizationId !== organizationId) {
        throw new GovernanceApiProblem(
          403,
          "organization_scope_violation",
          "The organization scope header must match the organization path.",
        );
      }
      if (identity.organizationIds !== "*" && !identity.organizationIds?.includes(organizationId)) {
        throw new GovernanceApiProblem(
          403,
          "organization_scope_violation",
          "The credential cannot access the requested organization.",
        );
      }

      const read =
        request.method === "GET" &&
        (route.resource === "retention-policy" ||
          route.resource === "governance-operations" ||
          route.operationId !== undefined);
      const required = read ? "governance:read" : "governance:write";
      if (!permits(identity.scopes, required)) {
        throw new GovernanceApiProblem(
          403,
          "insufficient_scope",
          "The credential does not have the required governance capability.",
        );
      }
      if (
        identity.opaqueCredential &&
        route.resource === "erasures" &&
        request.method === "POST" &&
        route.operationId === undefined
      ) {
        throw new GovernanceApiProblem(
          403,
          "erasure_requires_signed_identity",
          "Tenant erasure must be initiated with an issuer-signed identity that can poll the receipt after API keys are deleted.",
        );
      }
      if (
        identity.erasureReceiptOnly &&
        (route.resource !== "erasures" ||
          !(
            (request.method === "GET" && route.operationId !== undefined) ||
            (request.method === "POST" && route.operationId === undefined)
          ))
      ) {
        throw new GovernanceApiProblem(
          403,
          "erasure_receipt_access_denied",
          "This signed identity is valid only for its tenant erasure operation.",
        );
      }
      // Human callers need an organization role for governance mutations; API keys are governed by
      // scopes alone, and receipt-only identities can only replay their own completed erasure.
      if (
        request.method !== "GET" &&
        identity.authentication !== "api-credential" &&
        !identity.erasureReceiptOnly &&
        !actsUnderOperatorAccess(identity, organizationId)
      ) {
        const action = operationRoleAction(route.operation) ?? "resources.mutate";
        if (!organizationRoleAllows(identity.organizationRole, action)) {
          throw new GovernanceApiProblem(
            403,
            "insufficient_role",
            `${action === "governance.erase" ? "Tenant erasure" : "Governance mutations"} require one of these organization roles: ${organizationRolesAllowing(action).join(", ")}.`,
          );
        }
      }
      const operatorAccessGrant =
        identity.operatorAccess && actsUnderOperatorAccess(identity, organizationId)
          ? { operatorAccessGrantId: identity.operatorAccess.grantId }
          : {};

      if (request.method !== "GET" && !(await options.service.organizationExists(organizationId))) {
        let completedErasureReplay = false;
        if (
          request.method === "POST" &&
          route.resource === "erasures" &&
          route.operationId === undefined
        ) {
          const replayKey = Schema.decodeUnknownSync(
            IdempotencyKey,
            strict,
          )(request.headers.get("idempotency-key") ?? undefined);
          const replay = await options.service.getOperation(
            organizationId,
            deterministicOperationId(
              organizationId,
              "tenant-erasure",
              replayKey,
              identity.principalId,
            ),
          );
          completedErasureReplay =
            replay?.kind === "tenant-erasure" &&
            replay.status === "completed" &&
            (!identity.erasureReceiptOnly || erasureOperationMatchesIdentity(replay, identity));
        }
        if (!completedErasureReplay) {
          throw new GovernanceApiProblem(
            410,
            "organization_erased",
            "The organization has been erased and cannot accept new mutations.",
          );
        }
      }

      if (route.resource === "retention-policy") {
        if (request.method === "GET") {
          if (!(await options.service.organizationExists(organizationId))) {
            throw new GovernanceApiProblem(
              410,
              "organization_erased",
              "The organization has been erased.",
            );
          }
          const policy = await options.service.getRetentionPolicy(organizationId);
          const response = Schema.decodeUnknownSync(
            OrganizationRetentionPolicyResponse,
            strict,
          )(policy);
          return Response.json(response, { headers: { "x-request-id": requestId } });
        }
        const body = Schema.decodeUnknownSync(
          UpdateOrganizationRetentionPolicyRequest,
          strict,
        )(await jsonBody(request));
        const idempotencyKey = Schema.decodeUnknownSync(
          IdempotencyKey,
          strict,
        )(request.headers.get("idempotency-key") ?? undefined);
        const response = await mutation(options, {
          body,
          idempotencyKey,
          identity,
          operation: () =>
            options.service.updateRetentionPolicy({
              ...operatorAccessGrant,
              organizationId,
              patch: body,
              principalId: identity.principalId,
            }),
          organizationId,
          route: "updateOrganizationRetentionPolicy",
        });
        return Response.json(
          Schema.decodeUnknownSync(OrganizationRetentionPolicyResponse, strict)(response),
          { headers: { "x-request-id": requestId } },
        );
      }

      if (route.resource === "governance-operations") {
        if (!(await options.service.organizationExists(organizationId))) {
          throw new GovernanceApiProblem(
            410,
            "organization_erased",
            "The organization has been erased.",
          );
        }
        const page = await options.service.listOperations({
          ...historyQuery(request),
          organizationId,
        });
        const response = Schema.decodeUnknownSync(
          GovernanceOperationPageResponse,
          strict,
        )({
          items: await Promise.all(
            page.items.map((item) => operationResponse(options.createDownloadUrl, item)),
          ),
          ...(page.cursor ? { nextCursor: page.cursor } : {}),
        });
        return Response.json(response, { headers: { "x-request-id": requestId } });
      }

      if (route.operationId) {
        const operationId = Schema.decodeUnknownSync(PublicId, strict)(route.operationId);
        const operation = await options.service.getOperation(organizationId, operationId);
        if (!operation || operation.kind !== expectedKind(route.resource)) {
          throw new GovernanceApiProblem(
            404,
            "operation_not_found",
            "Governance operation not found.",
          );
        }
        if (identity.erasureReceiptOnly && !erasureOperationMatchesIdentity(operation, identity)) {
          throw new GovernanceApiProblem(
            404,
            "operation_not_found",
            "Governance operation not found.",
          );
        }
        return Response.json(await operationResponse(options.createDownloadUrl, operation), {
          headers: { "x-request-id": requestId },
        });
      }

      const kind = expectedKind(route.resource);
      const body =
        kind === "tenant-erasure"
          ? Schema.decodeUnknownSync(CreateTenantErasureRequest, strict)(await jsonBody(request))
          : undefined;
      const idempotencyKey = Schema.decodeUnknownSync(
        IdempotencyKey,
        strict,
      )(request.headers.get("idempotency-key") ?? undefined);
      const create = async () => {
        const input = {
          idempotencyKey,
          kind,
          operationId: deterministicOperationId(
            organizationId,
            kind,
            idempotencyKey,
            identity.principalId,
          ),
          ...operatorAccessGrant,
          organizationId,
          principalId: identity.principalId,
        };
        if (identity.erasureReceiptOnly && kind === "tenant-erasure") {
          const existing = await options.service.getOperation(organizationId, input.operationId);
          if (!erasureOperationMatchesIdentity(existing, identity)) {
            throw new GovernanceApiProblem(
              404,
              "operation_not_found",
              "Governance operation not found.",
            );
          }
        }
        if (kind === "tenant-erasure") return options.service.requestOperation(input);
        const existing = await options.service.getOperation(organizationId, input.operationId);
        if (existing) {
          if (
            existing.kind !== kind ||
            existing.idempotencyKey !== idempotencyKey ||
            existing.requestedByPrincipalId !== identity.principalId ||
            !existing.dispatchReadyAt
          ) {
            throw new GovernanceApiProblem(
              409,
              "governance_operation_conflict",
              "The deterministic governance operation ID is already bound to another request.",
            );
          }
          return existing;
        }
        return options.service.prepareOperation(input);
      };
      // Erasure replays are reconciled from the pseudonymous receipt by the
      // governance store. Writing a normal tenant-scoped idempotency record
      // after completion would recreate the organization data just erased.
      const requested =
        kind === "tenant-erasure"
          ? await create()
          : await mutation(options, {
              body,
              completionOperations: (operation) =>
                options.dispatchCompletion(operation, operatorAccessGrant.operatorAccessGrantId),
              idempotencyKey,
              identity,
              operation: create,
              organizationId,
              route: `create:${kind}`,
            });
      // Export dispatch happens only after mutation() has durably completed its
      // idempotency record. The operation record remains a durable outbox for
      // the scheduled dispatch reconciler if this immediate send fails.
      if (requested.status !== "completed") {
        await options.enqueue({
          operationId: requested.id,
          organizationId,
        });
      }
      if (identity.erasureReceiptOnly && !erasureOperationMatchesIdentity(requested, identity)) {
        throw new GovernanceApiProblem(
          404,
          "operation_not_found",
          "Governance operation not found.",
        );
      }
      return Response.json(await operationResponse(options.createDownloadUrl, requested), {
        headers: { "x-request-id": requestId },
        status: 202,
      });
    } catch (cause) {
      return problem(
        cause,
        requestId,
        `${request.method} /v1/organizations/{organizationId}/${route.resource}${route.operationId === undefined ? "" : "/{operationId}"}`,
      );
    }
  };
}
