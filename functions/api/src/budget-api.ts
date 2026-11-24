import { createHmac, randomUUID } from "node:crypto";
import {
  BUDGET_API_ROUTES,
  BUDGET_SCOPE_LEVELS,
  PUBLIC_ID_PATTERN,
  decodePublicRequest,
  decodePublicResponse,
  type BudgetApiRouteName,
  type CreateBudgetRequest,
  type UpdateBudgetRequest,
} from "@deployments-ai/api-contract";
import {
  MAX_BUDGET_PERIOD_PAGE_SIZE,
  PersistenceError,
  organizationRoleAllows,
  organizationRolesAllowing,
  recordApiCredentialUsageBestEffort,
  type ApiCredentialUsageRecorder,
  type BudgetActor,
  type BudgetPersistence,
  type BudgetRecordValue,
  type ScopeLevel,
  type ScopeTarget,
  type IdempotencyPersistence,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { errorLogFields } from "./error-log-fields.ts";
import type { ApiIdentity } from "./index.ts";
import { actsUnderOperatorAccess, selectedOrganization } from "./scope-permissions.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const pinned: true = true satisfies Same<(typeof BUDGET_SCOPE_LEVELS)[number], ScopeLevel>;
void pinned;

/** Active state of a project, environment, or workspace a budget may target. */
interface BudgetTargetResource {
  readonly id: string;
  readonly organizationId: string;
  readonly status: string;
}

export interface BudgetTargetEnvironment extends BudgetTargetResource {
  readonly projectId: string;
}

export interface CreateBudgetApiOptions {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly budgets: BudgetPersistence;
  readonly idempotency: IdempotencyPersistence;
  readonly recordApiCredentialUsage?: ApiCredentialUsageRecorder;
  readonly requestId?: () => string;
  /** Load a target the identity may read; they throw `PersistenceError` when it cannot. */
  readonly resolveEnvironment: (
    identity: ApiIdentity,
    organizationId: string,
    environmentId: string,
  ) => Promise<BudgetTargetEnvironment>;
  readonly resolveProject: (
    identity: ApiIdentity,
    organizationId: string,
    projectId: string,
  ) => Promise<BudgetTargetResource>;
  /** Load a workspace of `environmentId`; it throws a not-found error for any other's. */
  readonly resolveWorkspace: (
    identity: ApiIdentity,
    environmentId: string,
    workspaceId: string,
  ) => Promise<BudgetTargetResource>;
}

class BudgetApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BudgetApiProblem";
  }
}

const DEFAULT_BUDGET_PAGE_SIZE = 50;
const MAX_BUDGET_PAGE_SIZE = 100;
const BUDGET_MANAGE_ROLES = organizationRolesAllowing("budgets.manage");

const matchers = BUDGET_API_ROUTES.map((route) => ({
  pattern: new RegExp(`^${route.path.replace(":id", "([^/]+)")}$`, "u"),
  route,
}));

const PERSISTENCE_STATUS = {
  "invalid-input": 400,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  unprocessable: 422,
  internal: 500,
} as const;

function problem(status: number, code: string, detail: string, requestId: string) {
  return Response.json(
    {
      code,
      detail,
      requestId,
      status,
      title: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Request failed",
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

function errorResponse(cause: unknown, requestId: string) {
  if (cause instanceof BudgetApiProblem) {
    return problem(cause.status, cause.code, cause.message, requestId);
  }
  if (cause instanceof PersistenceError) {
    return problem(PERSISTENCE_STATUS[cause.kind], cause.code, cause.message, requestId);
  }
  if (cause instanceof Schema.SchemaError || cause instanceof SyntaxError) {
    return problem(
      422,
      "validation_failed",
      "The request did not match the API contract.",
      requestId,
    );
  }
  if (cause instanceof URIError) {
    return problem(400, "invalid_path_parameter", "A path parameter is malformed.", requestId);
  }
  return problem(500, "internal_error", "The budget request failed.", requestId);
}

function permits(scopes: readonly string[], required: "budgets:read" | "budgets:write") {
  return (
    scopes.includes("platform:*") ||
    scopes.includes("platform:admin") ||
    scopes.includes("budgets:*") ||
    scopes.includes(required)
  );
}

function holds(granted: readonly string[] | "*" | undefined, id: string | undefined) {
  return granted === undefined || granted === "*" || (id !== undefined && granted.includes(id));
}

function narrowed(granted: readonly string[] | "*" | undefined) {
  return granted !== undefined && granted !== "*";
}

/**
 * Identities narrowed to projects or environments see only budgets on what they hold; the
 * organization budget governs resources beyond their grant, so it stays hidden from them. A
 * workspace budget is visible wherever its environment is.
 */
function identityCanAccessBudget(
  identity: ApiIdentity,
  budget: Pick<BudgetRecordValue["data"], "environmentId" | "projectId" | "scope">,
) {
  if (actsUnderOperatorAccess(identity, selectedOrganization(identity))) return true;
  if (budget.scope === "organization") {
    return !narrowed(identity.projectIds) && !narrowed(identity.environmentIds);
  }
  if (!holds(identity.projectIds, budget.projectId)) return false;
  if (budget.scope === "project") return !narrowed(identity.environmentIds);
  return holds(identity.environmentIds, budget.environmentId);
}

function budgetResponse(record: BudgetRecordValue) {
  const budget = record.data;
  return decodePublicResponse("getBudget", {
    amountUsdMicros: budget.amountUsdMicros,
    ...(budget.archivedAt ? { archivedAt: budget.archivedAt } : {}),
    createdAt: budget.createdAt,
    ...(budget.environmentId ? { environmentId: budget.environmentId } : {}),
    id: budget.id,
    name: budget.name,
    organizationId: budget.organizationId,
    period: budget.period,
    ...(budget.projectId ? { projectId: budget.projectId } : {}),
    scope: budget.scope,
    status: budget.status,
    thresholds: [...budget.thresholds],
    updatedAt: budget.updatedAt,
    version: budget.version,
    ...(budget.workspaceId ? { workspaceId: budget.workspaceId } : {}),
  });
}

function pageLimit(url: URL, maximum: number, fallback: number) {
  const raw = url.searchParams.get("limit");
  if (raw === null) return fallback;
  if (!/^[1-9]\d*$/u.test(raw) || Number(raw) > maximum) {
    throw new BudgetApiProblem(
      400,
      "invalid_limit",
      `limit must be an integer from 1 through ${maximum}.`,
    );
  }
  return Number(raw);
}

function actorOf(identity: ApiIdentity): BudgetActor {
  return {
    ...(PUBLIC_ID_PATTERN.test(identity.principalId) ? { id: identity.principalId as Ulid } : {}),
    type: identity.authentication === "api-credential" ? "service-account" : "principal",
  };
}

function invalidTarget(message: string): never {
  throw new BudgetApiProblem(422, "invalid_budget_target", message);
}

async function resolveTarget(
  options: CreateBudgetApiOptions,
  identity: ApiIdentity,
  organizationId: string,
  body: typeof CreateBudgetRequest.Type,
): Promise<ScopeTarget> {
  if (body.scope === "organization") {
    if (body.projectId || body.environmentId || body.workspaceId) {
      invalidTarget("Organization budgets must not name a project, environment, or workspace.");
    }
    return { scope: "organization" };
  }
  if (body.scope === "project") {
    if (!body.projectId) invalidTarget("Project budgets require projectId.");
    if (body.environmentId) invalidTarget("Project budgets must not name an environment.");
    if (body.workspaceId) invalidTarget("Project budgets must not name a workspace.");
    const project = await options.resolveProject(identity, organizationId, body.projectId);
    assertActiveTarget(project, organizationId, "project");
    return { projectId: project.id as Ulid, scope: "project" };
  }
  if (body.scope === "environment" && body.workspaceId) {
    invalidTarget("Environment budgets must not name a workspace.");
  }
  const workspaceId =
    body.scope === "workspace"
      ? (body.workspaceId ?? invalidTarget("Workspace budgets require workspaceId."))
      : undefined;
  if (!body.environmentId) {
    invalidTarget("Environment and workspace budgets require environmentId.");
  }
  const environment = await options.resolveEnvironment(
    identity,
    organizationId,
    body.environmentId,
  );
  assertActiveTarget(environment, organizationId, "environment");
  if (body.projectId && body.projectId !== environment.projectId) {
    invalidTarget("projectId must be the project that owns the environment.");
  }
  const environmentTarget = {
    environmentId: environment.id as Ulid,
    projectId: environment.projectId as Ulid,
  };
  if (workspaceId === undefined) return { ...environmentTarget, scope: "environment" };
  const workspace = await options.resolveWorkspace(identity, environment.id, workspaceId);
  assertActiveTarget(workspace, organizationId, "workspace");
  return { ...environmentTarget, scope: "workspace", workspaceId: workspace.id as Ulid };
}

function assertActiveTarget(
  target: BudgetTargetResource,
  organizationId: string,
  kind: "environment" | "project" | "workspace",
) {
  if (target.organizationId !== organizationId) {
    throw new BudgetApiProblem(404, `${kind}_not_found`, `The ${kind} was not found.`);
  }
  if (target.status !== "active") {
    throw new BudgetApiProblem(409, `${kind}_not_active`, `Budgets require an active ${kind}.`);
  }
}

interface BudgetRequestContext {
  readonly body: unknown;
  readonly budgetId?: Ulid;
  readonly identity: ApiIdentity;
  readonly organizationId: Ulid;
  readonly url: URL;
}

async function accessibleBudget(options: CreateBudgetApiOptions, context: BudgetRequestContext) {
  const budget = await options.budgets.get(context.organizationId, context.budgetId!);
  if (!identityCanAccessBudget(context.identity, budget.data)) {
    throw new PersistenceError("not-found", "budget_not_found", "The budget was not found.");
  }
  return budget;
}

async function invoke(
  options: CreateBudgetApiOptions,
  routeName: BudgetApiRouteName,
  context: BudgetRequestContext,
): Promise<unknown> {
  const { identity, organizationId, url } = context;
  switch (routeName) {
    case "listBudgets": {
      const page = await options.budgets.list({
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        limit: pageLimit(url, MAX_BUDGET_PAGE_SIZE, DEFAULT_BUDGET_PAGE_SIZE),
        organizationId,
      });
      return decodePublicResponse("listBudgets", {
        items: page.items
          .filter((budget) => identityCanAccessBudget(identity, budget.data))
          .map(budgetResponse),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    }
    case "createBudget": {
      const body = context.body as typeof CreateBudgetRequest.Type;
      const target = await resolveTarget(options, identity, organizationId, body);
      if (!identityCanAccessBudget(identity, target)) {
        throw new BudgetApiProblem(
          403,
          "budget_scope_violation",
          "The credential cannot manage budgets for the requested scope.",
        );
      }
      return budgetResponse(
        await options.budgets.create({
          actor: actorOf(identity),
          amountUsdMicros: body.amountUsdMicros,
          name: body.name,
          organizationId,
          period: body.period,
          target,
          ...(body.thresholds ? { thresholds: body.thresholds } : {}),
        }),
      );
    }
    case "getBudget":
      return budgetResponse(await accessibleBudget(options, context));
    case "updateBudget": {
      await accessibleBudget(options, context);
      const body = context.body as typeof UpdateBudgetRequest.Type;
      return budgetResponse(
        await options.budgets.update({
          actor: actorOf(identity),
          budgetId: context.budgetId!,
          organizationId,
          ...(body.amountUsdMicros === undefined ? {} : { amountUsdMicros: body.amountUsdMicros }),
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.status === undefined ? {} : { status: body.status }),
          ...(body.thresholds === undefined ? {} : { thresholds: body.thresholds }),
        }),
      );
    }
    case "archiveBudget":
      await accessibleBudget(options, context);
      return budgetResponse(
        await options.budgets.archive({
          actor: actorOf(identity),
          budgetId: context.budgetId!,
          organizationId,
        }),
      );
    case "listBudgetPeriods": {
      await accessibleBudget(options, context);
      const page = await options.budgets.listPeriods({
        budgetId: context.budgetId!,
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        limit: pageLimit(url, MAX_BUDGET_PERIOD_PAGE_SIZE, MAX_BUDGET_PERIOD_PAGE_SIZE),
        organizationId,
      });
      return decodePublicResponse("listBudgetPeriods", {
        items: page.items.map((period) => ({
          ...period,
          notifiedThresholds: [...period.notifiedThresholds],
        })),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    }
  }
}

function authorize(
  identity: ApiIdentity,
  route: (typeof BUDGET_API_ROUTES)[number],
  organizationId: string,
) {
  const administrator = actsUnderOperatorAccess(identity, organizationId);
  if (
    !administrator &&
    identity.organizationIds !== "*" &&
    !identity.organizationIds?.includes(organizationId)
  ) {
    throw new BudgetApiProblem(
      403,
      "organization_scope_violation",
      "The credential cannot access the requested organization.",
    );
  }
  if (!permits(identity.scopes, route.requiredAuthorization)) {
    throw new BudgetApiProblem(
      403,
      "insufficient_scope",
      `The credential does not have the required ${route.requiredAuthorization} capability.`,
    );
  }
  // Human callers need a budget-managing organization role; API keys are governed by scopes alone.
  if (
    route.method !== "GET" &&
    identity.authentication !== "api-credential" &&
    !administrator &&
    !organizationRoleAllows(identity.organizationRole, "budgets.manage")
  ) {
    throw new BudgetApiProblem(
      403,
      "insufficient_role",
      `Budget changes require one of these organization roles: ${BUDGET_MANAGE_ROLES.join(", ")}.`,
    );
  }
}

export function createBudgetApiHandler(options: CreateBudgetApiOptions) {
  const recordUsage = async (identity: ApiIdentity, request: Request, organizationId: string) => {
    if (
      identity.authentication !== "api-credential" ||
      !identity.apiCredentialId ||
      identity.projectIds === "*" ||
      identity.projectIds?.length !== 1 ||
      identity.environmentIds === "*" ||
      identity.environmentIds?.length !== 1
    ) {
      return;
    }
    await recordApiCredentialUsageBestEffort(
      options.recordApiCredentialUsage,
      {
        apiCredentialId: identity.apiCredentialId,
        environmentId: identity.environmentIds[0]!,
        organizationId,
        outcome: "allowed",
        projectId: identity.projectIds[0]!,
        requestMethod: request.method,
        requestPath: new URL(request.url).pathname,
      },
      (error) => {
        console.error("API credential usage recording failed.", {
          error: error instanceof Error ? error.message : "Unknown recorder error.",
        });
      },
    );
  };

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const matcher = matchers.find(
      (candidate) => candidate.route.method === method && candidate.pattern.test(url.pathname),
    );
    if (!matcher) return undefined;
    const { route } = matcher;
    const requestId = options.requestId?.() ?? randomUUID();
    try {
      const rawBudgetId = matcher.pattern.exec(url.pathname)?.[1];
      const identity = await options.authenticate(request);
      if (!identity) {
        return problem(401, "unauthorized", "A valid bearer credential is required.", requestId);
      }
      const rawOrganizationId = request.headers.get("x-deployments-organization")?.trim();
      if (!rawOrganizationId) {
        return problem(
          400,
          "missing_organization_context",
          "x-deployments-organization is required.",
          requestId,
        );
      }
      if (!PUBLIC_ID_PATTERN.test(rawOrganizationId)) {
        return problem(
          400,
          "invalid_organization_context",
          "x-deployments-organization must be a canonical public ID.",
          requestId,
        );
      }
      const organizationId = rawOrganizationId as Ulid;
      authorize(identity, route, organizationId);
      await recordUsage(identity, request, organizationId);

      let budgetId: Ulid | undefined;
      if (rawBudgetId !== undefined) {
        const decoded = decodeURIComponent(rawBudgetId);
        if (!PUBLIC_ID_PATTERN.test(decoded)) {
          throw new PersistenceError("not-found", "budget_not_found", "The budget was not found.");
        }
        budgetId = decoded as Ulid;
      }
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (route.idempotency === "required" && !idempotencyKey) {
        return problem(400, "missing_idempotency_key", "Idempotency-Key is required.", requestId);
      }
      const body =
        "requestBody" in route
          ? decodePublicRequest(
              route.name,
              await request
                .text()
                .then((text) => (text ? (JSON.parse(text) as unknown) : undefined)),
            )
          : undefined;
      const context: BudgetRequestContext = {
        body,
        ...(budgetId ? { budgetId } : {}),
        identity,
        organizationId,
        url,
      };
      const operation = () => invoke(options, route.name, context);
      const result =
        route.idempotency === "required" && idempotencyKey
          ? await options.idempotency.execute({
              fingerprint: createHmac(
                "sha256",
                JSON.stringify([identity.principalId, idempotencyKey]),
              )
                .update(
                  JSON.stringify({
                    body,
                    budgetId,
                    method,
                    organizationId,
                    path: route.path,
                  }),
                )
                .digest("hex"),
              key: `${organizationId}:${idempotencyKey}`,
              operation,
              organizationId,
              principalId: identity.principalId,
            })
          : await operation();
      return Response.json(result, {
        headers: { "x-request-id": requestId },
        status: route.successStatus,
      });
    } catch (cause) {
      const response = errorResponse(cause, requestId);
      if (response.status === 500) {
        console.error("Budget API request failed.", {
          ...errorLogFields(cause),
          requestId,
          route: route.name,
        });
      }
      return response;
    }
  };
}
