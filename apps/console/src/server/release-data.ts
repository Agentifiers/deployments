import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export type AgentRelease = RouteResponse<"getAgentRelease">;

/**
 * One release with its published manifest. The Releases tab reads up to four at once (latest,
 * open, and the compared pair), so a burst throttled by the gateway retries.
 */
export function loadAgentRelease(
  accessToken: string,
  scope: EnvironmentScope,
  releaseId: string,
): Promise<AgentRelease> {
  return callRoute("getAgentRelease", { path: { id: releaseId }, scope }, accessToken);
}

/** Publishes the definition's current draft as its next immutable release. */
export function publishAgentRelease(
  accessToken: string,
  input: {
    readonly body: unknown;
    readonly definitionId: string;
    readonly idempotencyKey: string;
    readonly scope: EnvironmentScope;
  },
): Promise<AgentRelease> {
  return callRoute(
    "publishAgentRelease",
    {
      body: decodeRequestBody("publishAgentRelease", "PublishAgentReleaseRequest", input.body),
      idempotencyKey: input.idempotencyKey,
      path: { id: input.definitionId },
      scope: input.scope,
    },
    accessToken,
  );
}

/**
 * Copies a release into another environment of the same project; the response is the release
 * in the target environment, under the target definition with the same slug.
 */
export function promoteAgentRelease(
  accessToken: string,
  input: {
    readonly body: unknown;
    readonly idempotencyKey: string;
    readonly releaseId: string;
    readonly scope: EnvironmentScope;
  },
): Promise<AgentRelease> {
  return callRoute(
    "promoteAgentRelease",
    {
      body: decodeRequestBody("promoteAgentRelease", "PromoteAgentReleaseRequest", input.body),
      idempotencyKey: input.idempotencyKey,
      path: { id: input.releaseId },
      scope: input.scope,
    },
    accessToken,
  );
}

/** Archives a release no active deployment pins; it can no longer be deployed or promoted. */
export function archiveAgentRelease(
  accessToken: string,
  input: {
    readonly body: unknown;
    readonly idempotencyKey: string;
    readonly releaseId: string;
    readonly scope: EnvironmentScope;
  },
): Promise<AgentRelease> {
  return callRoute(
    "archiveAgentRelease",
    {
      body: decodeRequestBody("archiveAgentRelease", "ArchiveAgentResourceRequest", input.body),
      idempotencyKey: input.idempotencyKey,
      path: { id: input.releaseId },
      scope: input.scope,
    },
    accessToken,
  );
}
