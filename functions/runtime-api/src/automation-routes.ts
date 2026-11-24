import {
  archiveHeartbeat,
  archiveSchedule,
  createHeartbeat,
  createSchedule,
  fireHeartbeat,
  fireSchedule,
  getHeartbeat,
  getSchedule,
  pauseHeartbeat,
  pauseSchedule,
  resumeHeartbeat,
  resumeSchedule,
  updateHeartbeat,
  updateSchedule,
} from "@deployments-ai/automations";
import { listAutomationHistory } from "./aggregate-history.ts";
import { hasActiveRun } from "./fire-runtime.ts";
import { publicHeartbeat, publicSchedule } from "./public-projections.ts";
import { recordActor } from "./runtime-principal.ts";
import {
  numberValue,
  optionalBooleanValue,
  optionalObjectValue,
  runtimeListCursor,
  stringValue,
} from "./request-validation.ts";
import type { RuntimeRouteContext } from "./runtime-handler.ts";
import type { HttpApiResult } from "./runtime-support.ts";
import {
  assertRecord,
  automationDependencies,
  id,
  listEnvironmentRecords,
  publicRecord,
  requiredIdempotencyKey,
  requireScope,
  response,
  validatedIdempotencyKey,
} from "./runtime-support.ts";

export async function handleAutomationRoutes(
  context: RuntimeRouteContext,
): Promise<HttpApiResult | undefined> {
  const { body, dependencies, event, method, path, principal } = context;
  let match: RegExpExecArray | null;

  if (method === "GET" && path === "/v1/schedules") {
    requireScope(principal, "schedules:read");
    const page = await listEnvironmentRecords(
      dependencies.database,
      "control",
      principal.scope.environmentId,
      "schedule",
      {
        ...(event.queryStringParameters?.cursor !== undefined
          ? {
              cursor: runtimeListCursor(event.queryStringParameters.cursor),
            }
          : {}),
        ...(event.queryStringParameters?.limit
          ? { limit: Number(event.queryStringParameters.limit) }
          : {}),
      },
    );
    return response(200, {
      schedules: page.items
        .filter((record) => {
          const data = record.data as Readonly<Record<string, unknown>>;
          return (
            data.organizationId === principal.scope.organizationId &&
            data.projectId === principal.scope.projectId
          );
        })
        .map((record) => publicSchedule(assertRecord(record, "schedule", "Schedule"))),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }
  if (method === "POST" && path === "/v1/schedules") {
    requireScope(principal, "schedules:write");
    const timezone = stringValue(body, "timezone", false);
    const threadId = stringValue(body, "threadId", false);
    const workspaceId = stringValue(body, "workspaceId", false);
    const requestedWorkspaceId = workspaceId ? id(workspaceId, "workspaceId") : undefined;
    const schedule = await createSchedule(
      {
        ...principal.scope,
        agentDeploymentId: id(stringValue(body, "agentDeploymentId"), "agentDeploymentId"),
        createdBy: recordActor(principal),
        expression: stringValue(body, "expression")!,
        idempotencyKey: requiredIdempotencyKey(event),
        name: stringValue(body, "name")!,
        prompt: stringValue(body, "prompt")!,
        ...(threadId ? { threadId: id(threadId, "threadId") } : {}),
        ...(timezone ? { timezone } : {}),
        ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
      },
      automationDependencies(dependencies),
    );
    return response(201, publicSchedule(schedule));
  }
  if (method === "GET" && (match = /^\/v1\/schedules\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "schedules:read");
    return response(
      200,
      publicSchedule(
        await getSchedule(
          { ...principal.scope, scheduleId: id(match[1], "scheduleId") },
          automationDependencies(dependencies),
        ),
      ),
    );
  }
  if (method === "PATCH" && (match = /^\/v1\/schedules\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "schedules:write");
    return response(
      200,
      publicSchedule(
        await updateSchedule(
          {
            ...principal.scope,
            ...(stringValue(body, "expression", false)
              ? { expression: stringValue(body, "expression")! }
              : {}),
            ...(stringValue(body, "name", false) ? { name: stringValue(body, "name")! } : {}),
            ...(stringValue(body, "prompt", false) ? { prompt: stringValue(body, "prompt")! } : {}),
            scheduleId: id(match[1], "scheduleId"),
            ...("timezone" in body
              ? {
                  timezone: body.timezone === null ? null : stringValue(body, "timezone")!,
                }
              : {}),
          },
          automationDependencies(dependencies),
        ),
      ),
    );
  }
  if (method === "DELETE" && (match = /^\/v1\/schedules\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "schedules:write");
    return response(
      200,
      publicSchedule(
        await archiveSchedule(
          { ...principal.scope, scheduleId: id(match[1], "scheduleId") },
          automationDependencies(dependencies),
        ),
      ),
    );
  }
  if (method === "POST" && (match = /^\/v1\/schedules\/([^/]+)\/pause$/u.exec(path))) {
    requireScope(principal, "schedules:write");
    return response(
      200,
      publicSchedule(
        await pauseSchedule(
          { ...principal.scope, scheduleId: id(match[1], "scheduleId") },
          automationDependencies(dependencies),
        ),
      ),
    );
  }
  if (method === "POST" && (match = /^\/v1\/schedules\/([^/]+)\/resume$/u.exec(path))) {
    requireScope(principal, "schedules:write");
    return response(
      200,
      publicSchedule(
        await resumeSchedule(
          { ...principal.scope, scheduleId: id(match[1], "scheduleId") },
          automationDependencies(dependencies),
        ),
      ),
    );
  }
  if (method === "GET" && (match = /^\/v1\/schedules\/([^/]+)\/fires$/u.exec(path))) {
    requireScope(principal, "schedules:read");
    const scheduleId = id(match[1], "scheduleId");
    await getSchedule({ ...principal.scope, scheduleId }, automationDependencies(dependencies));
    const page = await listAutomationHistory(dependencies.database, {
      ...(event.queryStringParameters?.cursor
        ? { cursor: runtimeListCursor(event.queryStringParameters.cursor) }
        : {}),
      id: scheduleId,
      ...(event.queryStringParameters?.limit
        ? { limit: Number(event.queryStringParameters.limit) }
        : {}),
      organizationId: principal.scope.organizationId,
      type: "schedule",
    });
    return response(200, {
      fires: page.items.map(publicRecord),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }
  if (method === "POST" && (match = /^\/v1\/schedules\/([^/]+)\/fire$/u.exec(path))) {
    requireScope(principal, "schedules:write");
    const requestedFireKey = stringValue(body, "fireKey", false);
    const result = await fireSchedule(
      {
        ...principal.scope,
        fireKey:
          requestedFireKey === undefined
            ? requiredIdempotencyKey(event)
            : validatedIdempotencyKey(requestedFireKey, "fireKey"),
        scheduleId: id(match[1], "scheduleId"),
      },
      automationDependencies(dependencies),
    );
    return response(202, {
      duplicate: result.duplicate,
      fire: publicRecord(result.fire),
      ...(result.run ? { run: result.run } : {}),
    });
  }
  if (method === "GET" && path === "/v1/heartbeats") {
    requireScope(principal, "schedules:read");
    const page = await listEnvironmentRecords(
      dependencies.database,
      "execution",
      principal.scope.environmentId,
      "heartbeat",
      {
        ...(event.queryStringParameters?.cursor !== undefined
          ? {
              cursor: runtimeListCursor(event.queryStringParameters.cursor),
            }
          : {}),
        ...(event.queryStringParameters?.limit
          ? { limit: Number(event.queryStringParameters.limit) }
          : {}),
      },
    );
    return response(200, {
      heartbeats: page.items
        .filter((record) => {
          const data = record.data as Readonly<Record<string, unknown>>;
          return (
            data.organizationId === principal.scope.organizationId &&
            data.projectId === principal.scope.projectId
          );
        })
        .map((record) => publicHeartbeat(assertRecord(record, "heartbeat", "Heartbeat"))),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }
  if (method === "POST" && path === "/v1/heartbeats") {
    requireScope(principal, "schedules:write");
    const intervalMs = numberValue(body, "intervalMs");
    const activeWindow = optionalObjectValue(body, "activeWindow");
    const skipWhenBusy = optionalBooleanValue(body, "skipWhenBusy");
    const timezone = stringValue(body, "timezone", false);
    const threadId = stringValue(body, "threadId", false);
    const workspaceId = stringValue(body, "workspaceId", false);
    const requestedWorkspaceId = workspaceId ? id(workspaceId, "workspaceId") : undefined;
    const heartbeat = await createHeartbeat(
      {
        ...principal.scope,
        ...(activeWindow ? { activeWindow } : {}),
        agentDeploymentId: id(stringValue(body, "agentDeploymentId"), "agentDeploymentId"),
        createdBy: recordActor(principal),
        idempotencyKey: requiredIdempotencyKey(event),
        instructions: stringValue(body, "instructions")!,
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        ...(skipWhenBusy !== undefined ? { skipWhenBusy } : {}),
        ...(threadId ? { threadId: id(threadId, "threadId") } : {}),
        ...(timezone ? { timezone } : {}),
        ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
      },
      automationDependencies(dependencies),
    );
    return response(201, publicHeartbeat(heartbeat));
  }
  if (method === "GET" && (match = /^\/v1\/heartbeats\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "schedules:read");
    return response(
      200,
      publicHeartbeat(
        await getHeartbeat(
          { ...principal.scope, heartbeatId: id(match[1], "heartbeatId") },
          automationDependencies(dependencies),
        ),
      ),
    );
  }
  if (method === "PATCH" && (match = /^\/v1\/heartbeats\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "schedules:write");
    const intervalMs = numberValue(body, "intervalMs");
    const skipWhenBusy = optionalBooleanValue(body, "skipWhenBusy");
    return response(
      200,
      publicHeartbeat(
        await updateHeartbeat(
          {
            ...principal.scope,
            ...("activeWindow" in body
              ? {
                  activeWindow:
                    body.activeWindow === null ? null : optionalObjectValue(body, "activeWindow")!,
                }
              : {}),
            heartbeatId: id(match[1], "heartbeatId"),
            ...(stringValue(body, "instructions", false)
              ? { instructions: stringValue(body, "instructions")! }
              : {}),
            ...(intervalMs !== undefined ? { intervalMs } : {}),
            ...(skipWhenBusy !== undefined ? { skipWhenBusy } : {}),
            ...("timezone" in body
              ? {
                  timezone: body.timezone === null ? null : stringValue(body, "timezone")!,
                }
              : {}),
          },
          automationDependencies(dependencies),
        ),
      ),
    );
  }
  if (method === "DELETE" && (match = /^\/v1\/heartbeats\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "schedules:write");
    return response(
      200,
      publicHeartbeat(
        await archiveHeartbeat(
          { ...principal.scope, heartbeatId: id(match[1], "heartbeatId") },
          automationDependencies(dependencies),
        ),
      ),
    );
  }
  if (method === "POST" && (match = /^\/v1\/heartbeats\/([^/]+)\/pause$/u.exec(path))) {
    requireScope(principal, "schedules:write");
    return response(
      200,
      publicHeartbeat(
        await pauseHeartbeat(
          { ...principal.scope, heartbeatId: id(match[1], "heartbeatId") },
          automationDependencies(dependencies),
        ),
      ),
    );
  }
  if (method === "POST" && (match = /^\/v1\/heartbeats\/([^/]+)\/resume$/u.exec(path))) {
    requireScope(principal, "schedules:write");
    return response(
      200,
      publicHeartbeat(
        await resumeHeartbeat(
          { ...principal.scope, heartbeatId: id(match[1], "heartbeatId") },
          automationDependencies(dependencies),
        ),
      ),
    );
  }
  if (method === "GET" && (match = /^\/v1\/heartbeats\/([^/]+)\/fires$/u.exec(path))) {
    requireScope(principal, "schedules:read");
    const heartbeatId = id(match[1], "heartbeatId");
    await getHeartbeat({ ...principal.scope, heartbeatId }, automationDependencies(dependencies));
    const page = await listAutomationHistory(dependencies.database, {
      ...(event.queryStringParameters?.cursor
        ? { cursor: runtimeListCursor(event.queryStringParameters.cursor) }
        : {}),
      id: heartbeatId,
      ...(event.queryStringParameters?.limit
        ? { limit: Number(event.queryStringParameters.limit) }
        : {}),
      organizationId: principal.scope.organizationId,
      type: "heartbeat",
    });
    return response(200, {
      fires: page.items.map(publicRecord),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }
  if (method === "POST" && (match = /^\/v1\/heartbeats\/([^/]+)\/fire$/u.exec(path))) {
    requireScope(principal, "schedules:write");
    const requestedFireKey = stringValue(body, "fireKey", false);
    const result = await fireHeartbeat(
      {
        ...principal.scope,
        agentDeploymentId: id(stringValue(body, "agentDeploymentId"), "agentDeploymentId"),
        fireKey:
          requestedFireKey === undefined
            ? requiredIdempotencyKey(event)
            : validatedIdempotencyKey(requestedFireKey, "fireKey"),
        hasActiveRun: (
          agentDeploymentId,
          currentRunIdempotencyKey,
          workspaceId,
          includeOtherActiveRuns,
        ) =>
          hasActiveRun(
            dependencies.database,
            principal.scope.environmentId,
            agentDeploymentId,
            currentRunIdempotencyKey,
            {
              organizationId: principal.scope.organizationId,
              projectId: principal.scope.projectId,
              ...(workspaceId ? { workspaceId } : {}),
            },
            includeOtherActiveRuns,
          ),
        heartbeatId: id(match[1], "heartbeatId"),
      },
      automationDependencies(dependencies),
    );
    return response(202, {
      duplicate: result.duplicate,
      heartbeatRun: publicRecord(result.heartbeatRun),
      ...(result.run ? { run: result.run } : {}),
    });
  }
  return undefined;
}
