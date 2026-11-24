import { createHmac, randomUUID } from "node:crypto";
import {
  MAX_ALERT_INCIDENTS_PAGE_LIMIT,
  MAX_MONITORS_PAGE_LIMIT,
  MONITOR_API_ROUTES,
  PUBLIC_ID_PATTERN,
  decodePublicRequest,
  decodePublicResponse,
  type CreateMonitorRequest,
  type MonitorApiRouteName,
  type PutAlertNotificationPreferencesRequest,
  type UpdateMonitorRequest,
} from "@deployments-ai/api-contract";
import {
  MONITOR_KINDS,
  MonitorCondition,
  MonitorNotify,
  PersistenceError,
  Ulid as UlidSchema,
  organizationRoleAllows,
  organizationRolesAllowing,
  recordApiCredentialUsageBestEffort,
  type AlertHistory,
  type ApiCredentialUsageRecorder,
  type IdempotencyPersistence,
  type MonitorIncidentRecord,
  type MonitorPersistence,
  type MonitorRecord,
  type MonitorScope,
  type MonitorStateRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { errorLogFields } from "./error-log-fields.ts";
import type { ApiIdentity } from "./index.ts";
import { actsUnderOperatorAccess, selectedOrganization } from "./scope-permissions.ts";

export interface MonitorTargetEnvironment {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly status: string;
}

export interface CreateMonitorApiOptions {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly history: AlertHistory;
  readonly idempotency: IdempotencyPersistence;
  readonly monitors: MonitorPersistence;
  readonly recordApiCredentialUsage?: ApiCredentialUsageRecorder;
  readonly requestId?: () => string;
  /** Loads an environment the identity may read; throws `PersistenceError` when it cannot. */
  readonly resolveEnvironment: (
    identity: ApiIdentity,
    environmentId: string,
  ) => Promise<MonitorTargetEnvironment>;
}

class MonitorApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MonitorApiProblem";
  }
}

const MONITOR_MANAGE_ROLES = organizationRolesAllowing("monitors.manage");
const PERSISTENCE_STATUS = {
  "invalid-input": 422,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  unprocessable: 422,
  internal: 500,
} as const;

const matchers = MONITOR_API_ROUTES.map((route) => ({
  pattern: new RegExp(
    `^${route.path.replace(":id", "([^/]+)").replace(":incidentId", "([^/]+)")}$`,
    "u",
  ),
  route,
}));

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
      headers: { "content-type": "application/problem+json", "x-request-id": requestId },
      status,
    },
  );
}

function errorResponse(cause: unknown, requestId: string) {
  if (cause instanceof MonitorApiProblem) {
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
  return problem(500, "internal_error", "The monitor request failed.", requestId);
}

function permits(scopes: readonly string[], required: "monitors:read" | "monitors:write") {
  return (
    scopes.includes("platform:*") ||
    scopes.includes("platform:admin") ||
    scopes.includes("monitors:*") ||
    scopes.includes(required) ||
    (required === "monitors:read" && scopes.includes("monitors:write"))
  );
}

function narrowed(granted: readonly string[] | "*" | undefined) {
  return granted !== undefined && granted !== "*";
}

function holds(granted: readonly string[] | "*" | undefined, id: string | undefined) {
  return !narrowed(granted) || (id !== undefined && (granted as readonly string[]).includes(id));
}

/**
 * Identities narrowed to projects or environments see the monitors and incidents of what they
 * hold; organization monitors watch spend beyond their grant, so they stay hidden from them.
 */
function canAccess(
  identity: ApiIdentity,
  resource: { readonly environmentId?: string; readonly projectId?: string },
) {
  if (actsUnderOperatorAccess(identity, selectedOrganization(identity))) return true;
  if (resource.environmentId === undefined) {
    return !narrowed(identity.projectIds) && !narrowed(identity.environmentIds);
  }
  return (
    holds(identity.projectIds, resource.projectId) &&
    holds(identity.environmentIds, resource.environmentId)
  );
}

function monitorResponse(monitor: MonitorRecord, state: MonitorStateRecord | undefined) {
  const data = monitor.data;
  return decodePublicResponse("getMonitor", {
    ...(data.archivedAt ? { archivedAt: data.archivedAt } : {}),
    condition: data.condition,
    createdAt: data.createdAt,
    ...(data.environmentId ? { environmentId: data.environmentId } : {}),
    id: data.id,
    ...(data.mutedUntil ? { mutedUntil: data.mutedUntil } : {}),
    name: data.name,
    notify: data.notify,
    organizationId: data.organizationId,
    ...(data.projectId ? { projectId: data.projectId } : {}),
    ...(data.renotifyMinutes === undefined ? {} : { renotifyMinutes: data.renotifyMinutes }),
    state: state?.data.phase === "firing" && data.status !== "archived" ? "firing" : "ok",
    status: data.status,
    updatedAt: data.updatedAt,
    version: data.version,
  });
}

function incidentResponse(incident: MonitorIncidentRecord) {
  const data = incident.data;
  return decodePublicResponse("getAlertIncident", {
    ...(data.environmentId ? { environmentId: data.environmentId } : {}),
    id: data.id,
    kind: data.kind,
    monitorId: data.monitorId,
    monitorName: data.monitorName,
    openedAt: data.openedAt,
    organizationId: data.organizationId,
    ...(data.projectId ? { projectId: data.projectId } : {}),
    ...(data.resolution ? { resolution: data.resolution } : {}),
    ...(data.resolvedAt ? { resolvedAt: data.resolvedAt } : {}),
    status: data.status,
    summary: data.summary,
    timeline: data.timeline,
  });
}

function pageLimit(url: URL, maximum: number) {
  const raw = url.searchParams.get("limit");
  if (raw === null) return maximum;
  if (!/^[1-9]\d*$/u.test(raw) || Number(raw) > maximum) {
    throw new MonitorApiProblem(
      400,
      "invalid_limit",
      `limit must be an integer from 1 through ${maximum}.`,
    );
  }
  return Number(raw);
}

function monitorCursor(url: URL) {
  const raw = url.searchParams.get("cursor");
  if (raw === null) return undefined;
  if (!PUBLIC_ID_PATTERN.test(raw)) {
    throw new MonitorApiProblem(400, "invalid_cursor", "cursor is not a monitor list cursor.");
  }
  return raw;
}

function environmentQuery(url: URL) {
  const raw = url.searchParams.get("environmentId");
  if (raw === null) return undefined;
  if (!PUBLIC_ID_PATTERN.test(raw)) {
    throw new MonitorApiProblem(400, "invalid_environment", "environmentId is not a public ID.");
  }
  return raw as Ulid;
}

/** Public IDs in a request become the platform's internal IDs by decoding, not by casting. */
const toCondition = Schema.decodeUnknownSync(MonitorCondition);
const toNotify = Schema.decodeUnknownSync(MonitorNotify);
const toUlids = Schema.decodeUnknownSync(Schema.Array(UlidSchema));

function invalidTarget(message: string): never {
  throw new MonitorApiProblem(422, "invalid_monitor_target", message);
}

interface MonitorRequestContext {
  readonly body: unknown;
  readonly identity: ApiIdentity;
  readonly incidentId?: Ulid;
  readonly monitorId?: Ulid;
  readonly organizationId: Ulid;
  readonly url: URL;
}

async function resolveScope(
  options: CreateMonitorApiOptions,
  context: MonitorRequestContext,
  body: typeof CreateMonitorRequest.Type,
): Promise<MonitorScope> {
  if (MONITOR_KINDS[body.condition.kind].scope === "organization") {
    if (body.environmentId || body.projectId) {
      invalidTarget(
        `${MONITOR_KINDS[body.condition.kind].label} monitors watch the whole organization.`,
      );
    }
    if (!canAccess(context.identity, {})) {
      throw new MonitorApiProblem(
        403,
        "monitor_scope_violation",
        "The credential cannot manage organization monitors.",
      );
    }
    return { kind: "organization" };
  }
  if (!body.environmentId) invalidTarget("Environment monitors require environmentId.");
  const environment = await options.resolveEnvironment(context.identity, body.environmentId);
  if (
    environment.organizationId !== context.organizationId ||
    environment.status !== "active" ||
    (body.projectId !== undefined && body.projectId !== environment.projectId)
  ) {
    invalidTarget("The environment is not an active environment of this organization.");
  }
  if (
    !canAccess(context.identity, {
      environmentId: environment.id,
      projectId: environment.projectId,
    })
  ) {
    throw new MonitorApiProblem(
      403,
      "monitor_scope_violation",
      "The credential cannot manage monitors in that environment.",
    );
  }
  return {
    environmentId: environment.id as Ulid,
    kind: "environment",
    projectId: environment.projectId as Ulid,
  };
}

async function accessibleMonitor(options: CreateMonitorApiOptions, context: MonitorRequestContext) {
  const snapshot = await options.monitors.snapshot(context.organizationId, context.monitorId!);
  if (!snapshot || !canAccess(context.identity, snapshot.monitor.data)) {
    throw new PersistenceError("not-found", "monitor_not_found", "The monitor was not found.");
  }
  return snapshot;
}

function humanPrincipal(identity: ApiIdentity) {
  if (
    identity.authentication === "api-credential" ||
    !PUBLIC_ID_PATTERN.test(identity.principalId)
  ) {
    throw new MonitorApiProblem(
      403,
      "human_principal_required",
      "Only a signed-in member has alert email settings.",
    );
  }
  return identity.principalId as Ulid;
}

async function invoke(
  options: CreateMonitorApiOptions,
  routeName: MonitorApiRouteName,
  context: MonitorRequestContext,
) {
  const { identity, organizationId, url } = context;
  switch (routeName) {
    case "listMonitors": {
      const environmentId = environmentQuery(url);
      const limit = pageLimit(url, MAX_MONITORS_PAGE_LIMIT);
      const after = monitorCursor(url);
      // Newest first by ULID, so the cursor (the last id shown) stays put when monitors change.
      const ordered = (await options.monitors.list(organizationId))
        .filter(
          (monitor) =>
            canAccess(identity, monitor.data) &&
            (environmentId === undefined || monitor.data.environmentId === environmentId) &&
            (after === undefined || monitor.data.id < after),
        )
        .toSorted((left, right) => (left.data.id < right.data.id ? 1 : -1));
      const shown = ordered.slice(0, limit);
      const states = await Promise.all(
        shown.map((monitor) => options.monitors.snapshot(organizationId, monitor.data.id)),
      );
      const last = shown.at(-1);
      return decodePublicResponse("listMonitors", {
        items: shown.map((monitor, index) => monitorResponse(monitor, states[index]?.state)),
        ...(ordered.length > limit && last ? { nextCursor: last.data.id } : {}),
      });
    }
    case "createMonitor": {
      const body = context.body as typeof CreateMonitorRequest.Type;
      const scope = await resolveScope(options, context, body);
      const monitor = await options.monitors.create({
        condition: toCondition(body.condition),
        name: body.name,
        notify: toNotify(body.notify),
        organizationId,
        ...(body.renotifyMinutes === undefined ? {} : { renotifyMinutes: body.renotifyMinutes }),
        scope,
      });
      return monitorResponse(monitor, undefined);
    }
    case "getMonitor": {
      const snapshot = await accessibleMonitor(options, context);
      return monitorResponse(snapshot.monitor, snapshot.state);
    }
    case "updateMonitor": {
      await accessibleMonitor(options, context);
      const body = context.body as typeof UpdateMonitorRequest.Type;
      const monitor = await options.monitors.update({
        ...(body.condition
          ? { condition: body.condition as MonitorRecord["data"]["condition"] }
          : {}),
        ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
        monitorId: context.monitorId!,
        ...(body.mute === undefined
          ? {}
          : {
              mute: body.mute === null ? null : body.mute.until ? { until: body.mute.until } : {},
            }),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.notify ? { notify: toNotify(body.notify) } : {}),
        organizationId,
        ...(body.renotifyMinutes === undefined ? {} : { renotifyMinutes: body.renotifyMinutes }),
      });
      const snapshot = await options.monitors.snapshot(organizationId, monitor.data.id);
      return monitorResponse(monitor, snapshot?.state);
    }
    case "archiveMonitor": {
      await accessibleMonitor(options, context);
      return monitorResponse(
        await options.monitors.archive(organizationId, context.monitorId!),
        undefined,
      );
    }
    case "testMonitor": {
      await accessibleMonitor(options, context);
      return decodePublicResponse(
        "testMonitor",
        await options.monitors.sendTest({
          monitorId: context.monitorId!,
          organizationId,
          requestedByPrincipalId: humanPrincipal(identity),
        }),
      );
    }
    case "listAlertIncidents": {
      const environmentId = environmentQuery(url);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const page = await options.history.listIncidents({
        ...(cursor ? { cursor } : {}),
        ...(environmentId ? { environmentId } : {}),
        limit: pageLimit(url, MAX_ALERT_INCIDENTS_PAGE_LIMIT),
        organizationId,
      });
      return decodePublicResponse("listAlertIncidents", {
        items: page.items.filter((item) => canAccess(identity, item.data)).map(incidentResponse),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    }
    case "getAlertIncident": {
      const incident = await options.history.getIncident(
        organizationId,
        context.monitorId!,
        context.incidentId!,
      );
      if (!canAccess(identity, incident.data)) {
        throw new PersistenceError("not-found", "incident_not_found", "The alert was not found.");
      }
      return incidentResponse(incident);
    }
    case "getAlertNotificationPreferences": {
      const preference = await options.history.preference(organizationId, humanPrincipal(identity));
      return decodePublicResponse("getAlertNotificationPreferences", {
        email: preference?.data.email ?? "all",
        mutedMonitorIds: preference?.data.mutedMonitorIds ?? [],
      });
    }
    case "putAlertNotificationPreferences": {
      const body = context.body as typeof PutAlertNotificationPreferencesRequest.Type;
      const stored = await options.history.putPreference({
        email: body.email,
        mutedMonitorIds: toUlids(body.mutedMonitorIds),
        organizationId,
        principalId: humanPrincipal(identity),
      });
      return decodePublicResponse("putAlertNotificationPreferences", {
        email: stored.data.email,
        mutedMonitorIds: stored.data.mutedMonitorIds,
      });
    }
  }
}

function authorize(
  identity: ApiIdentity,
  route: (typeof MONITOR_API_ROUTES)[number],
  organizationId: string,
) {
  const administrator = actsUnderOperatorAccess(identity, organizationId);
  if (
    !administrator &&
    identity.organizationIds !== "*" &&
    !identity.organizationIds?.includes(organizationId)
  ) {
    throw new MonitorApiProblem(
      403,
      "organization_scope_violation",
      "The credential cannot access the requested organization.",
    );
  }
  if (!permits(identity.scopes, route.requiredAuthorization)) {
    throw new MonitorApiProblem(
      403,
      "insufficient_scope",
      `The credential does not have the required ${route.requiredAuthorization} capability.`,
    );
  }
  // Each member manages their own alert email settings; monitor changes need a managing role.
  if (
    route.requiredAuthorization === "monitors:write" &&
    identity.authentication !== "api-credential" &&
    !administrator &&
    !organizationRoleAllows(identity.organizationRole, "monitors.manage")
  ) {
    throw new MonitorApiProblem(
      403,
      "insufficient_role",
      `Monitor changes require one of these organization roles: ${MONITOR_MANAGE_ROLES.join(", ")}.`,
    );
  }
}

function pathId(raw: string | undefined, code: string): Ulid | undefined {
  if (raw === undefined) return undefined;
  const decoded = decodeURIComponent(raw);
  if (!PUBLIC_ID_PATTERN.test(decoded)) {
    throw new PersistenceError("not-found", code, "The monitor or alert was not found.");
  }
  return decoded as Ulid;
}

/** Monitors, alert history, and each member's alert email settings. */
export function createMonitorApiHandler(options: CreateMonitorApiOptions) {
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
      const [, rawMonitorId, rawIncidentId] = matcher.pattern.exec(url.pathname) ?? [];
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
      const monitorId = pathId(rawMonitorId, "monitor_not_found");
      const incidentId = pathId(rawIncidentId, "incident_not_found");
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
      const context: MonitorRequestContext = {
        body,
        identity,
        ...(incidentId ? { incidentId } : {}),
        ...(monitorId ? { monitorId } : {}),
        organizationId,
        url,
      };
      const operation = () => invoke(options, route.name, context);
      const result =
        route.idempotency !== "none" && idempotencyKey
          ? await options.idempotency.execute({
              fingerprint: createHmac(
                "sha256",
                JSON.stringify([identity.principalId, idempotencyKey]),
              )
                .update(
                  JSON.stringify({ body, method, monitorId, organizationId, path: route.path }),
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
        console.error("Monitor API request failed.", {
          ...errorLogFields(cause),
          requestId,
          route: route.name,
        });
      }
      return response;
    }
  };
}
