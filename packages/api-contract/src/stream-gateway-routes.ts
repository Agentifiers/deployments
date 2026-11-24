import type { RuntimeApiRouteContract } from "./runtime-contracts.ts";
import { runtimeStreamQueryParameters } from "./runtime-page-contracts.ts";

/**
 * Operations served by the public stream gateway rather than the runtime API. Clients read the
 * absolute `streamUrl` returned by `createThreadStreamSession`.
 */
export const STREAM_GATEWAY_API_ROUTES = [
  {
    authentication: "stream-session",
    errors: [400, 401, 403, 404, 500, 503],
    eventStreamContentType: "text/event-stream",
    idempotency: "none",
    method: "GET",
    name: "readThreadStream",
    path: "/v1/threads/:threadId/stream",
    queryParameters: runtimeStreamQueryParameters,
    requiredAuthorization: "read",
    requiredPermission: "read",
    responseBody: "RuntimeStreamResponse",
    responseContentType: "application/json",
    scopeHeaders: "none",
    server: "stream-gateway",
    successStatus: 200,
    tag: "Runtime",
  },
] as const satisfies readonly RuntimeApiRouteContract[];
