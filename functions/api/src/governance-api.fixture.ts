import { createHash } from "node:crypto";
import { operatorAccessGrant } from "@deployments-ai/db/operator-access-testing";
import {
  GovernanceError,
  type GovernanceOperation,
  type GovernanceService,
} from "@deployments-ai/governance";
import { PersistenceError } from "@deployments-ai/db";
import { createGovernanceApiHandler } from "./governance-api.ts";

export const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const OTHER_PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FZZ";

export function fixture(idempotencyFailure?: PersistenceError) {
  const queued: unknown[] = [];
  const sequence: string[] = [];
  let idempotencyExecutions = 0;
  let requesterMembershipExists = true;
  let organizationExists = true;
  let policy = {
    artifacts: 365,
    audit: 2_555,
    createdAt: "2026-07-25T00:00:00.000Z",
    events: 365,
    messages: 365,
    organizationId: ORGANIZATION_ID,
    runs: 365,
    threads: 365,
    updatedAt: "2026-07-25T00:00:00.000Z",
    updatedByPrincipalId: PRINCIPAL_ID,
    version: 0,
  };
  const operations = new Map<string, GovernanceOperation>();
  const buildOperation = (input: {
    idempotencyKey: string;
    kind: GovernanceOperation["kind"];
    operationId?: string;
    organizationId: string;
    principalId: string;
  }): GovernanceOperation => ({
    createdAt: "2026-07-25T00:00:00.000Z",
    id: input.operationId!,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    organizationId: input.organizationId,
    requestedByPrincipalId: input.principalId,
    status: "pending",
    updatedAt: "2026-07-25T00:00:00.000Z",
    version: 1,
  });
  const listQueries: unknown[] = [];
  const dispatchGrants: (string | undefined)[] = [];
  const service = {
    getOperation: async (_organizationId: string, operationId: string) =>
      operations.get(operationId),
    getRetentionPolicy: async () => policy,
    listOperations: async (query: {
      readonly kind?: string;
      readonly limit: number;
      readonly status?: string;
    }) => {
      listQueries.push(query);
      const items = [...operations.values()]
        .filter(
          (operation) =>
            (query.kind === undefined || operation.kind === query.kind) &&
            (query.status === undefined || operation.status === query.status),
        )
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
      return {
        ...(items.length > query.limit ? { cursor: "next-page" } : {}),
        items: items.slice(0, query.limit),
      };
    },
    prepareOperation: async (input: Parameters<typeof buildOperation>[0]) => {
      sequence.push("operation-prepared");
      return buildOperation(input);
    },
    requestOperation: async (input: {
      idempotencyKey: string;
      kind: GovernanceOperation["kind"];
      operationId?: string;
      organizationId: string;
      principalId: string;
    }) => {
      const existing = operations.get(input.operationId!);
      if (
        existing?.kind === "tenant-erasure" &&
        existing.status === "completed" &&
        existing.requestedByPrincipalId ===
          createHash("sha256").update(input.principalId).digest("hex")
      ) {
        return existing;
      }
      if (existing && existing.requestedByPrincipalId !== input.principalId) {
        throw new GovernanceError(
          "tenant_erasure_already_requested",
          "Tenant erasure has already been requested by another principal.",
        );
      }
      if (existing) return existing;
      const operation = buildOperation(input);
      operations.set(operation.id, operation);
      return operation;
    },
    updateRetentionPolicy: async (input: {
      patch: Partial<typeof policy>;
      principalId: string;
    }) => {
      policy = {
        ...policy,
        ...input.patch,
        updatedByPrincipalId: input.principalId,
        version: policy.version + 1,
      };
      return policy;
    },
    organizationExists: async () => organizationExists,
  } as unknown as GovernanceService;
  const handler = createGovernanceApiHandler({
    authenticate: async (request) => {
      if (request.headers.get("x-test-platform") === "true") {
        // What the authenticator admits for a non-member administrator under operator access.
        return {
          authentication: "tenant-jwt" as const,
          operatorAccess: operatorAccessGrant(ORGANIZATION_ID),
          organizationIds: [ORGANIZATION_ID],
          platformRole: "administrator" as const,
          principalId: PRINCIPAL_ID,
          scopes: ["platform:admin"],
        };
      }
      const path = new URL(request.url).pathname.split("/").filter(Boolean);
      const erasureReceiptRoute =
        path[3] === "erasures" &&
        ((request.method === "GET" && path.length === 5) ||
          (request.method === "POST" && path.length === 4));
      const erasureReceiptOnly = !organizationExists || !requesterMembershipExists;
      if (erasureReceiptOnly && !erasureReceiptRoute) return null;
      const opaque = request.headers.get("x-test-opaque") === "true";
      const role = request.headers.get("x-test-role") ?? "owner";
      return {
        authentication: opaque ? ("api-credential" as const) : ("tenant-jwt" as const),
        ...(erasureReceiptOnly ? { erasureReceiptOnly: true as const } : {}),
        ...(opaque ? { opaqueCredential: true as const } : {}),
        // Human callers carry their live organization role unless only an erasure receipt remains.
        ...(opaque || erasureReceiptOnly
          ? {}
          : { organizationRole: role as "admin" | "billing" | "member" | "owner" | "viewer" }),
        organizationIds: [ORGANIZATION_ID],
        principalId: request.headers.get("x-test-principal") ?? PRINCIPAL_ID,
        scopes: request.headers.get("x-test-scopes")?.split(",") ?? ["governance:*"],
      };
    },
    createDownloadUrl: async (reference) => ({
      expiresAt: "2026-07-25T00:05:00.000Z",
      url: `https://download.example.test/${reference.key}`,
    }),
    dispatchCompletion: (operation, operatorAccessGrantId) => {
      dispatchGrants.push(operatorAccessGrantId);
      if (operation.dispatchReadyAt) return [];
      sequence.push(`dispatch-ready-write:${operations.size}`);
      operations.set(operation.id, {
        ...operation,
        dispatchReadyAt: "2026-07-25T00:00:00.500Z",
        updatedAt: "2026-07-25T00:00:00.500Z",
      });
      return [];
    },
    enqueue: async (message) => {
      sequence.push("enqueue");
      queued.push(message);
    },
    idempotency: {
      execute: async (input) => {
        idempotencyExecutions += 1;
        if (idempotencyFailure) throw idempotencyFailure;
        sequence.push("idempotency-start");
        const result = await input.operation();
        input.completionOperations?.(result);
        sequence.push("idempotency-complete");
        return result;
      },
    },
    requestId: () => "req_governance",
    service,
  });
  return {
    dispatchGrants,
    handler,
    idempotencyExecutions: () => idempotencyExecutions,
    markOrganizationErased() {
      organizationExists = false;
      requesterMembershipExists = false;
      for (const [id, operation] of operations) {
        if (operation.kind !== "tenant-erasure" || operation.status !== "completed") continue;
        operations.set(id, {
          ...operation,
          requestedByPrincipalId: createHash("sha256")
            .update(operation.requestedByPrincipalId)
            .digest("hex"),
        });
      }
    },
    removeRequesterMembership() {
      requesterMembershipExists = false;
    },
    listQueries,
    operations,
    policy: () => policy,
    queued,
    sequence,
    service,
  };
}

export function request(path: string, init: RequestInit = {}) {
  const headers = new Headers({
    authorization: "Bearer test",
    "x-deployments-organization": ORGANIZATION_ID,
  });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return new Request(`https://api.example.test${path}`, { ...init, headers });
}
