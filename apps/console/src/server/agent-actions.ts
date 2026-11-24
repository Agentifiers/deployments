import "@tanstack/react-start/server-only";
import { PlatformApiError } from "../errors.ts";
import type { EnvironmentScope } from "../scope.ts";
import { requirePublicIds } from "./console-data.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

/** One console mutation: the caller's token, scope, per-dialog idempotency key, and raw body. */
export interface AgentMutation {
  readonly accessToken: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

/** A mutation of one deployment, addressed by its ID. */
export interface DeploymentMutation extends AgentMutation {
  readonly deploymentId: string;
}

export function createAgentDefinition({ accessToken, body, idempotencyKey, scope }: AgentMutation) {
  requirePublicIds({ ...scope });
  return callRoute(
    "createAgentDefinition",
    {
      body: decodeRequestBody("createAgentDefinition", "CreateAgentDefinitionRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

/** A mutation of the agent definition, addressed by its ID. */
export interface DefinitionMutation extends AgentMutation {
  readonly definitionId: string;
}

/** Replaces the draft manifest; `expectedVersion` is the definition version the editor loaded. */
export function updateAgentDefinition(mutation: DefinitionMutation) {
  const { accessToken, body, definitionId, idempotencyKey, scope } = mutation;
  requirePublicIds({ ...scope, definitionId });
  return callRoute(
    "updateAgentDefinition",
    {
      body: decodeRequestBody("updateAgentDefinition", "UpdateAgentDefinitionRequest", body),
      idempotencyKey,
      path: { id: definitionId },
      scope,
    },
    accessToken,
  );
}

/** Closes authoring; deployments keep running the releases they pin. */
export function archiveAgentDefinition(mutation: DefinitionMutation) {
  const { accessToken, body, definitionId, idempotencyKey, scope } = mutation;
  requirePublicIds({ ...scope, definitionId });
  return callRoute(
    "archiveAgentDefinition",
    {
      body: decodeRequestBody("archiveAgentDefinition", "ArchiveAgentResourceRequest", body),
      idempotencyKey,
      path: { id: definitionId },
      scope,
    },
    accessToken,
  );
}

/**
 * A retarget, pause, or resume. A runtime config is refused so that `withToolBindings`, through
 * the bindings editor and the connection rebind, stays its only writer.
 */
export function deploymentUpdateBody(body: unknown) {
  const update = decodeRequestBody("updateAgentDeployment", "UpdateAgentDeploymentRequest", body);
  if (update.runtimeConfig !== undefined) {
    throw new PlatformApiError("updateAgentDeployment", {
      detail: "Change a deployment's runtime configuration through its tool bindings editor.",
      status: 400,
      title: "Invalid request",
    });
  }
  return update;
}

export function updateAgentDeployment(mutation: DeploymentMutation) {
  const { accessToken, body, deploymentId, idempotencyKey, scope } = mutation;
  requirePublicIds({ ...scope, deploymentId });
  return callRoute(
    "updateAgentDeployment",
    {
      body: deploymentUpdateBody(body),
      idempotencyKey,
      path: { id: deploymentId },
      scope,
    },
    accessToken,
  );
}

export function stopAgentDeployment(mutation: DeploymentMutation) {
  const { accessToken, body, deploymentId, idempotencyKey, scope } = mutation;
  requirePublicIds({ ...scope, deploymentId });
  return callRoute(
    "stopAgentDeployment",
    {
      body: decodeRequestBody("stopAgentDeployment", "ArchiveAgentResourceRequest", body),
      idempotencyKey,
      path: { id: deploymentId },
      scope,
    },
    accessToken,
  );
}

export function startAgentDeploymentCanary(mutation: DeploymentMutation) {
  const { accessToken, body, deploymentId, idempotencyKey, scope } = mutation;
  requirePublicIds({ ...scope, deploymentId });
  return callRoute(
    "startAgentDeploymentCanary",
    {
      body: decodeRequestBody(
        "startAgentDeploymentCanary",
        "StartAgentDeploymentCanaryRequest",
        body,
      ),
      idempotencyKey,
      path: { id: deploymentId },
      scope,
    },
    accessToken,
  );
}

/** Promotes or aborts the deployment's running canary. */
export function resolveAgentDeploymentCanary(
  resolution: "abortAgentDeploymentCanary" | "promoteAgentDeploymentCanary",
  mutation: DeploymentMutation,
) {
  const { accessToken, body, deploymentId, idempotencyKey, scope } = mutation;
  requirePublicIds({ ...scope, deploymentId });
  const input = {
    body: decodeRequestBody(resolution, "ResolveAgentDeploymentCanaryRequest", body),
    idempotencyKey,
    path: { id: deploymentId },
    scope,
  };
  switch (resolution) {
    case "abortAgentDeploymentCanary":
      return callRoute("abortAgentDeploymentCanary", input, accessToken);
    case "promoteAgentDeploymentCanary":
      return callRoute("promoteAgentDeploymentCanary", input, accessToken);
  }
}
