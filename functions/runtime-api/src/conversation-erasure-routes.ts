import { emailAddressOfEndUserId } from "@deployments-ai/agent-email";
import { parseEndUserId } from "@deployments-ai/conversations";
import {
  redactConversationErasure,
  makeConversationErasureRequests,
  type GovernanceOperation,
} from "@deployments-ai/db";
import { endUserErasureRequest } from "./request-validation.ts";
import type { RuntimeRouteContext } from "./runtime-handler.ts";
import { recordActor } from "./runtime-principal.ts";
import {
  id,
  requireScope,
  response,
  RuntimeApiError,
  type HttpApiResult,
} from "./runtime-support.ts";

function erasureNotFound() {
  return new RuntimeApiError(404, "erasure_not_found", "Erasure not found.");
}

const RUNTIME_KIND = { "end-user-erasure": "end-user", "thread-erasure": "thread" } as const;

function publicErasure(operation: GovernanceOperation) {
  const redacted = redactConversationErasure(operation);
  if (!redacted) throw erasureNotFound();
  return { ...redacted, kind: RUNTIME_KIND[redacted.kind] };
}

export async function handleConversationErasureRoutes(
  context: RuntimeRouteContext,
): Promise<HttpApiResult | undefined> {
  const { body, dependencies, method, path, principal } = context;
  const erasures = makeConversationErasureRequests(
    dependencies.database,
    dependencies.now ? { now: dependencies.now } : {},
  );
  const { environmentId, organizationId } = principal.scope;
  let match: RegExpExecArray | null;

  if (method === "POST" && (match = /^\/v1\/threads\/([^/]+)\/erasures$/u.exec(path))) {
    requireScope(principal, "runs:erase");
    const threadId = id(match[1], "threadId");
    const result = await erasures.requestThreadErasure({
      requester: recordActor(principal),
      scope: principal.scope,
      threadId,
    });
    switch (result.kind) {
      case "created":
        return response(202, { erasure: publicErasure(result.operation) });
      case "replayed":
        return response(200, { erasure: publicErasure(result.operation) });
      case "not-found":
        throw new RuntimeApiError(404, "thread_not_found", "Thread not found.");
      case "not-erasable":
        throw new RuntimeApiError(
          409,
          "thread_not_erasable",
          "Preview and evaluation threads follow their execution binding's lifecycle.",
        );
      case "thread-active":
        throw new RuntimeApiError(
          409,
          "thread_active",
          "Threads with active runs cannot be erased; cancel the runs first.",
        );
    }
  }
  if (method === "GET" && (match = /^\/v1\/threads\/([^/]+)\/erasures\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "runs:read");
    const threadId = id(match[1], "threadId");
    const operation = await erasures.getOperation(organizationId, id(match[2], "erasureId"));
    const target = operation?.conversationErasure;
    if (
      !operation ||
      target?.environmentId !== environmentId ||
      target.target.kind !== "thread" ||
      target.target.threadId !== threadId
    ) {
      throw erasureNotFound();
    }
    return response(200, { erasure: publicErasure(operation) });
  }
  if (method === "POST" && path === "/v1/end-users/erasures") {
    requireScope(principal, "end-users:erase");
    const endUserId = parseEndUserId(endUserErasureRequest(body).endUserId, "erasure");
    const address = emailAddressOfEndUserId(endUserId);
    if (address && (await erasures.isOrganizationInboxAddress(organizationId, address))) {
      throw new RuntimeApiError(
        409,
        "end_user_is_inbox",
        "The address is one of the organization's agent email inboxes, not an end user.",
      );
    }
    const endUserKey = dependencies.endUserSubjects(organizationId, endUserId);
    const result = await erasures.requestEndUserErasure({
      endUserKey,
      environmentId,
      organizationId,
      requester: recordActor(principal),
    });
    return response(result.kind === "created" ? 202 : 200, {
      erasure: publicErasure(result.operation),
    });
  }
  if (method === "GET" && (match = /^\/v1\/end-users\/erasures\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "end-users:erase");
    const operation = await erasures.getOperation(organizationId, id(match[1], "erasureId"));
    const target = operation?.conversationErasure;
    if (
      !operation ||
      target?.environmentId !== environmentId ||
      target.target.kind !== "end-user"
    ) {
      throw erasureNotFound();
    }
    return response(200, { erasure: publicErasure(operation) });
  }
  return undefined;
}
