import { mutateChannelBindingCredential } from "./channel-credentials.ts";
import {
  archiveChannelBinding,
  composeChannelDelivery,
  createChannelBinding,
  loadChannelBinding,
  loadChannelDelivery,
  publicBinding,
  publicDelivery,
  updateChannelBinding,
  verifyChannelBinding,
} from "./channels.ts";
import {
  boundedStringValue,
  optionalObjectValue,
  runtimeListCursor,
  stringValue,
} from "./request-validation.ts";
import type { RuntimeRouteContext } from "./runtime-handler.ts";
import type { HttpApiResult } from "./runtime-support.ts";
import {
  id,
  listEnvironmentRecords,
  requiredIdempotencyKey,
  requireScope,
  response,
} from "./runtime-support.ts";

export async function handleChannelRoutes(
  context: RuntimeRouteContext,
): Promise<HttpApiResult | undefined> {
  const { body, dependencies, event, method, path, principal } = context;
  let match: RegExpExecArray | null;

  if (method === "GET" && path === "/v1/channel-bindings") {
    requireScope(principal, "channels:read");
    const page = await listEnvironmentRecords(
      dependencies.database,
      "control",
      principal.scope.environmentId,
      "channel-binding",
      {
        ...(event.queryStringParameters?.cursor !== undefined
          ? { cursor: runtimeListCursor(event.queryStringParameters.cursor) }
          : {}),
        ...(event.queryStringParameters?.limit
          ? { limit: Number(event.queryStringParameters.limit) }
          : {}),
      },
    );
    return response(200, {
      channelBindings: page.items
        .filter((record) => {
          const data = record.data as Readonly<Record<string, unknown>>;
          return (
            data.organizationId === principal.scope.organizationId &&
            data.projectId === principal.scope.projectId
          );
        })
        .map((record) => publicBinding(record as never)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }
  if (method === "POST" && path === "/v1/channel-bindings") {
    requireScope(principal, "channels:write");
    const metadata = optionalObjectValue(body, "metadata");
    const workspaceId = stringValue(body, "workspaceId", false);
    const connectionId = stringValue(body, "connectionId", false);
    const externalAccountId = boundedStringValue(body, "externalAccountId", 512, false);
    const externalChannelId = boundedStringValue(body, "externalChannelId", 512, false);
    const externalThreadKey = boundedStringValue(body, "externalThreadKey", 1_024, false);
    const externalWorkspaceId = boundedStringValue(body, "externalWorkspaceId", 512, false);
    const created = await createChannelBinding(
      principal,
      {
        agentDefinitionId: id(stringValue(body, "agentDefinitionId"), "agentDefinitionId"),
        agentDeploymentId: id(stringValue(body, "agentDeploymentId"), "agentDeploymentId"),
        channel: stringValue(body, "channel"),
        ...(connectionId ? { connectionId: id(connectionId, "connectionId") } : {}),
        ...(externalAccountId ? { externalAccountId } : {}),
        ...(externalChannelId ? { externalChannelId } : {}),
        ...(externalThreadKey ? { externalThreadKey } : {}),
        ...(externalWorkspaceId ? { externalWorkspaceId } : {}),
        idempotencyKey: requiredIdempotencyKey(event),
        ...(metadata ? { metadata } : {}),
        provider: stringValue(body, "provider"),
        ...(workspaceId ? { workspaceId: id(workspaceId, "workspaceId") } : {}),
      },
      dependencies,
    );
    return response(201, publicBinding(created));
  }
  if (
    (method === "PUT" || method === "DELETE") &&
    (match = /^\/v1\/channel-bindings\/([^/]+)\/credential$/u.exec(path))
  ) {
    const binding = await mutateChannelBindingCredential(
      principal,
      id(match[1], "bindingId"),
      method,
      body,
      dependencies,
    );
    return response(200, publicBinding(binding));
  }
  if (method === "POST" && (match = /^\/v1\/channel-bindings\/([^/]+)\/verify$/u.exec(path))) {
    requireScope(principal, "channels:write");
    const verified = await verifyChannelBinding(principal, id(match[1], "bindingId"), dependencies);
    return response(200, {
      ...publicBinding(verified),
      verification: "configuration-and-credential",
    });
  }
  if (method === "POST" && (match = /^\/v1\/channel-bindings\/([^/]+)\/deliveries$/u.exec(path))) {
    requireScope(principal, "channels:write");
    const externalChannelId = boundedStringValue(body, "externalChannelId", 512, false);
    const rcsMessage = optionalObjectValue(body, "rcsMessage");
    const result = await composeChannelDelivery(
      principal,
      id(match[1], "bindingId"),
      {
        content: boundedStringValue(body, "content", 40_000)!,
        ...(externalChannelId ? { externalChannelId } : {}),
        externalThreadKey: boundedStringValue(body, "externalThreadKey", 1_024)!,
        idempotencyKey: requiredIdempotencyKey(event),
        ...(rcsMessage ? { rcsMessage } : {}),
        runId: id(stringValue(body, "runId"), "runId"),
        threadId: id(stringValue(body, "threadId"), "threadId"),
      },
      dependencies,
    );
    return response(202, {
      delivery: publicDelivery(result.delivery),
      duplicate: result.duplicate,
    });
  }
  if (method === "GET" && (match = /^\/v1\/channel-bindings\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "channels:read");
    return response(
      200,
      publicBinding(await loadChannelBinding(principal, id(match[1], "bindingId"), dependencies)),
    );
  }
  if (method === "PATCH" && (match = /^\/v1\/channel-bindings\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "channels:write");
    return response(
      200,
      publicBinding(
        await updateChannelBinding(principal, id(match[1], "bindingId"), body, dependencies),
      ),
    );
  }
  if (method === "DELETE" && (match = /^\/v1\/channel-bindings\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "channels:write");
    return response(
      200,
      publicBinding(
        await archiveChannelBinding(principal, id(match[1], "bindingId"), dependencies),
      ),
    );
  }
  if (method === "GET" && path === "/v1/channel-deliveries") {
    requireScope(principal, "channels:read");
    const page = await listEnvironmentRecords(
      dependencies.database,
      "execution",
      principal.scope.environmentId,
      "channel-delivery",
      {
        ...(event.queryStringParameters?.cursor !== undefined
          ? { cursor: runtimeListCursor(event.queryStringParameters.cursor) }
          : {}),
        ...(event.queryStringParameters?.limit
          ? { limit: Number(event.queryStringParameters.limit) }
          : {}),
      },
    );
    return response(200, {
      channelDeliveries: page.items
        .filter((record) => {
          const data = record.data as Readonly<Record<string, unknown>>;
          return (
            data.organizationId === principal.scope.organizationId &&
            data.projectId === principal.scope.projectId
          );
        })
        .map((record) => publicDelivery(record as never)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }
  if (
    method === "GET" &&
    (match = /^\/v1\/runs\/([^/]+)\/channel-deliveries\/([^/]+)$/u.exec(path))
  ) {
    requireScope(principal, "channels:read");
    return response(
      200,
      publicDelivery(
        await loadChannelDelivery(
          principal,
          id(match[1], "runId"),
          id(match[2], "deliveryId"),
          dependencies,
        ),
      ),
    );
  }
  return undefined;
}
