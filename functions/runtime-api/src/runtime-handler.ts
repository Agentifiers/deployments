import { randomUUID } from "node:crypto";
import { RUNTIME_API_ROUTES } from "@deployments-ai/api-contract/runtime";
import { recordApiCredentialUsageBestEffort, type PlatformRecord } from "@deployments-ai/db";
import { createThreadStreamEvent } from "@deployments-ai/streaming";
import { organizationRefusalResult, routeActivity } from "@deployments-ai/organization-admission";
import { handleApprovalArtifactRoutes } from "./approval-artifact-routes.ts";
import { handleAutomationRoutes } from "./automation-routes.ts";
import { handleChannelRoutes } from "./channel-routes.ts";
import { handlePreviewRoutes } from "./preview-routes.ts";
import { handleConversationErasureRoutes } from "./conversation-erasure-routes.ts";
import { handleRunThreadRoutes } from "./run-thread-routes.ts";
import { handleRuntimeLogRoutes } from "./runtime-log-routes.ts";
import { handleWebhookRoutes } from "./webhook-routes.ts";
import { handleWorkflowExecutionRoutes } from "./workflow-execution-routes.ts";
import { cancelRun } from "./runtime-operations.ts";
import {
  assertScopeHeaders,
  authenticateRuntimeApi,
  requireHumanRouteRole,
} from "./runtime-authentication.ts";
import { streamActor } from "./runtime-principal.ts";
import type {
  HttpApiEvent,
  HttpApiResult,
  RuntimeApiDependencies,
  RuntimeApiPrincipal,
} from "./runtime-support.ts";
import {
  RuntimeApiError,
  headers,
  jsonBody,
  problem,
  runtimeApiErrorFromCause,
} from "./runtime-support.ts";

const runtimeRouteHandlers = [
  handleRunThreadRoutes,
  handleConversationErasureRoutes,
  handlePreviewRoutes,
  handleApprovalArtifactRoutes,
  handleWebhookRoutes,
  handleChannelRoutes,
  handleAutomationRoutes,
  handleWorkflowExecutionRoutes,
  handleRuntimeLogRoutes,
] as const;

export function runMutationThreadEvents(
  operation: "replay" | "retry",
  principal: RuntimeApiPrincipal,
  run: Extract<PlatformRecord, { readonly itemType: "run" }>,
) {
  const common = {
    actor: streamActor(principal),
    environmentId: run.data.environmentId,
    occurredAt: run.data.updatedAt,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
    runId: run.data.id,
    threadId: run.data.threadId,
  };
  if (operation === "retry") {
    return [
      createThreadStreamEvent({
        ...common,
        eventId: `run-retry:${run.data.id}:${run.data.version}`,
        eventType: "run.retry-requested",
        payload: {
          attempt: run.data.attempt,
          status: run.data.status,
          threadId: run.data.threadId,
        },
      }),
    ];
  }
  if (run.data.userMessageId === undefined || run.data.userMessageSequence === undefined) {
    throw new RuntimeApiError(
      500,
      "replay_message_missing",
      "Replayed run has no bound user message.",
    );
  }
  return [
    createThreadStreamEvent({
      ...common,
      eventId: `user-message-replayed:${run.data.id}:${run.data.userMessageId}`,
      eventType: "user-message.accepted",
      messageId: run.data.userMessageId,
      payload: {
        messageId: run.data.userMessageId,
        replayedFromRunId: run.data.replayedFromRunId,
        role: "user",
        runId: run.data.id,
        sequence: run.data.userMessageSequence,
        threadId: run.data.threadId,
      },
    }),
    createThreadStreamEvent({
      ...common,
      eventId: `run-replayed:${run.data.id}:${run.data.version}`,
      eventType: "run.replayed",
      payload: {
        replayedFromRunId: run.data.replayedFromRunId,
        status: run.data.status,
        threadId: run.data.threadId,
      },
    }),
  ];
}

export function cancelRunThreadEvents(
  principal: RuntimeApiPrincipal,
  result: Awaited<ReturnType<typeof cancelRun>>,
) {
  const run = result.run;
  const events: ReturnType<typeof createThreadStreamEvent>[] = [];
  const common = {
    environmentId: run.environmentId,
    organizationId: run.organizationId,
    projectId: run.projectId,
    runId: run.id,
    threadId: run.threadId,
  };
  if (result.approval) {
    events.push(
      createThreadStreamEvent({
        ...common,
        actor: streamActor(principal),
        approvalId: result.approval.data.id,
        eventId: `approval-resolved:${result.approval.data.id}:${result.approval.data.version}`,
        eventType: "approval.resolved",
        occurredAt: result.approval.data.resolvedAt ?? result.approval.data.updatedAt,
        payload: {
          decision: result.approval.data.status,
          status: result.approval.data.status,
        },
        ...(result.approval.data.toolCallId ? { toolCallId: result.approval.data.toolCallId } : {}),
      }),
    );
  }
  if (result.toolCall) {
    events.push(
      createThreadStreamEvent({
        ...common,
        actor: { type: "service" },
        ...(result.toolCall.data.approvalId ? { approvalId: result.toolCall.data.approvalId } : {}),
        eventId: `tool-canceled:${result.toolCall.data.id}:${result.toolCall.data.version}`,
        eventType: "tool.failed",
        occurredAt: result.toolCall.data.completedAt ?? result.toolCall.data.updatedAt,
        payload: {
          ...(result.toolCall.data.outputSummary
            ? { outputSummary: result.toolCall.data.outputSummary }
            : {}),
          status: result.toolCall.data.status,
        },
        toolCallId: result.toolCall.data.id,
      }),
    );
  }
  events.push(
    createThreadStreamEvent({
      ...common,
      actor: streamActor(principal),
      eventId: `run-terminal:${run.id}:${run.version}:canceled`,
      eventType: "run.canceled",
      occurredAt: run.completedAt ?? run.updatedAt,
      payload: {
        status: run.status,
        threadId: run.threadId,
      },
    }),
  );
  return events;
}

export async function publishRunMutationThreadEvents(
  _operation: "replay" | "retry",
  events: ReturnType<typeof runMutationThreadEvents>,
  append: (event: (typeof events)[number]) => Promise<void>,
) {
  for (const event of events) {
    await append(event);
  }
}

export type DeclaredRuntimeRoute = (typeof RUNTIME_API_ROUTES)[number];

function declaredRuntimeRoute(method: string, path: string): DeclaredRuntimeRoute | undefined {
  const pathParts = path.split("/");
  return RUNTIME_API_ROUTES.find((route) => {
    if (route.method !== method) return false;
    const routeParts = route.path.split("/");
    return (
      routeParts.length === pathParts.length &&
      routeParts.every((part, index) =>
        part.startsWith(":") ? Boolean(pathParts[index]) : part === pathParts[index],
      )
    );
  });
}
export interface RuntimeRouteContext {
  readonly body: ReturnType<typeof jsonBody>;
  readonly dependencies: RuntimeApiDependencies;
  readonly event: HttpApiEvent;
  readonly method: string;
  readonly path: string;
  readonly principal: RuntimeApiPrincipal;
}

export function createRuntimeApiHandler(dependencies: RuntimeApiDependencies) {
  return async (event: HttpApiEvent): Promise<HttpApiResult> => {
    const method = event.requestContext?.http?.method?.toUpperCase() ?? "GET";
    const path = event.rawPath;
    const requestId = headers(event)["x-request-id"];
    try {
      const route = declaredRuntimeRoute(method, path);
      if (!route) {
        throw new RuntimeApiError(
          404,
          "route_not_found",
          "The requested API route does not exist.",
        );
      }
      const principal = await authenticateRuntimeApi(event, dependencies);
      const decision = await dependencies.organizationGate?.admit(
        principal.scope.organizationId,
        routeActivity(route),
      );
      if (decision && decision.kind !== "admitted") {
        return organizationRefusalResult(decision, requestId ?? `req_${randomUUID()}`);
      }
      if (principal.kind === "human") {
        requireHumanRouteRole(principal, route.requiredScope);
      } else {
        await recordApiCredentialUsageBestEffort(
          dependencies.recordApiCredentialUsage,
          {
            apiCredentialId: principal.credential.data.id,
            ...principal.scope,
            outcome: "allowed",
            requestMethod: method,
            requestPath: path,
          },
          (error) => {
            console.error("API credential usage recording failed.", {
              error: error instanceof Error ? error.message : "Unknown recorder error.",
            });
          },
        );
        assertScopeHeaders(event, principal);
      }
      const body = jsonBody(event);

      const context: RuntimeRouteContext = { body, dependencies, event, method, path, principal };
      for (const handleRoutes of runtimeRouteHandlers) {
        const result = await handleRoutes(context);
        if (result) return result;
      }
      throw new RuntimeApiError(404, "route_not_found", "The requested API route does not exist.");
    } catch (cause) {
      const error = runtimeApiErrorFromCause(cause);
      if (error.status >= 500) {
        console.error("Runtime API request failed.", {
          cause,
          method,
          path,
          requestId,
        });
      }
      return problem(error, requestId);
    }
  };
}
