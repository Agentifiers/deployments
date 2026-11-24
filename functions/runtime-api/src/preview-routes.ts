import {
  DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
  createEphemeralTurnService,
  type ExecutionBinding,
} from "@deployments-ai/conversations";
import type { Ulid } from "@deployments-ai/db";
import { publicPreview, publicRun, publicThread } from "./public-projections.ts";
import { previewCreationRequest, previewTurnRequest } from "./request-validation.ts";
import type { RuntimeRouteContext } from "./runtime-handler.ts";
import { recordActor, runInitiatingCaller } from "./runtime-principal.ts";
import type { HttpApiResult, RuntimeApiPrincipal } from "./runtime-support.ts";
import {
  RuntimeApiError,
  appendRuntimeThreadEvent,
  id,
  publicRecord,
  requiredIdempotencyKey,
  requireScope,
  response,
} from "./runtime-support.ts";

/** Preview mutations run unpublished agent definitions, so they also require `agents:write`. */
function requirePreviewWriteScopes(principal: RuntimeApiPrincipal) {
  requireScope(principal, "runs:write");
  requireScope(principal, "agents:write");
}

export async function handlePreviewRoutes(
  context: RuntimeRouteContext,
): Promise<HttpApiResult | undefined> {
  const { body, dependencies, event, method, path, principal } = context;
  if (path !== "/v1/previews" && !path.startsWith("/v1/previews/")) return undefined;
  const service = createEphemeralTurnService({
    appendThreadEvent: (threadEvent, signal) =>
      appendRuntimeThreadEvent(dependencies, threadEvent, signal),
    database: dependencies.database,
    enqueueRun: dependencies.enqueueRun,
    generateId: dependencies.generateId,
    admitManifest: dependencies.admitManifest,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const actor = recordActor(principal);
  const now = () => dependencies.now?.() ?? new Date();
  // Evaluation bindings share storage with previews but are never addressable as previews.
  const loadPreview = async (previewId: Ulid): Promise<ExecutionBinding> => {
    const binding = await service.getExecutionBinding({
      ...principal.scope,
      executionBindingId: previewId,
    });
    if (binding.data.purpose !== "preview") {
      throw new RuntimeApiError(404, "not_found", "Preview was not found.");
    }
    return binding;
  };
  let match: RegExpExecArray | null;

  if (method === "POST" && path === "/v1/previews") {
    requirePreviewWriteScopes(principal);
    const idempotencyKey = requiredIdempotencyKey(event);
    const input = previewCreationRequest(body);
    const { binding } = await service.createExecutionBinding({
      ...principal.scope,
      createdBy: actor,
      idempotencyKey,
      purpose: "preview",
      ...(input.runtimeConfig !== undefined ? { runtimeConfig: input.runtimeConfig } : {}),
      ...(input.fromAgentDeploymentId
        ? {
            runtimeConfigFromAgentDeploymentId: id(
              input.fromAgentDeploymentId,
              "fromAgentDeploymentId",
            ),
          }
        : {}),
      source: { manifest: input.manifest, type: "manifest" },
      toolPolicy: "interactive",
      ttlSeconds: input.ttlSeconds ?? DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
    });
    return response(201, publicPreview(binding, now()));
  }
  if ((match = /^\/v1\/previews\/([^/]+)$/u.exec(path))) {
    const previewId = id(match[1], "previewId");
    if (method === "GET") {
      requireScope(principal, "runs:read");
      return response(200, publicPreview(await loadPreview(previewId), now()));
    }
    if (method === "DELETE") {
      requirePreviewWriteScopes(principal);
      await loadPreview(previewId);
      const expired = await service.expireExecutionBinding({
        ...principal.scope,
        actor,
        executionBindingId: previewId,
      });
      return response(200, publicPreview(expired, now()));
    }
    return undefined;
  }
  if (method === "POST" && (match = /^\/v1\/previews\/([^/]+)\/turns$/u.exec(path))) {
    requirePreviewWriteScopes(principal);
    const previewId = id(match[1], "previewId");
    const idempotencyKey = requiredIdempotencyKey(event);
    const input = previewTurnRequest(body);
    await loadPreview(previewId);
    const result = await service.submitEphemeralTurn({
      ...principal.scope,
      actor,
      content: input.content,
      executionBindingId: previewId,
      idempotencyKey,
      initiatingCaller: runInitiatingCaller(principal),
      ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
      ...(input.threadId ? { threadId: id(input.threadId, "threadId") } : {}),
    });
    return response(202, {
      created: result.created,
      message: publicRecord(result.message),
      run: publicRun(result.run),
      thread: publicThread(result.thread),
    });
  }
  return undefined;
}
