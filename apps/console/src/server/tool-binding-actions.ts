import "@tanstack/react-start/server-only";
import type { AgentManifestSemanticIssue } from "@deployments-ai/agent-manifest/semantics";
import { notFound } from "@tanstack/react-router";
import {
  assembleRuntimeConfig,
  type DeploymentConfig,
  type ToolBindingChanges,
} from "../agents/runtime-config.ts";
import { isRepinnable } from "../connections/rebind.ts";
import { PlatformApiError } from "../errors.ts";
import type { EnvironmentScope } from "../scope.ts";
import { requirePublicIds } from "./console-data.ts";
import { fanOut } from "./fan-out.ts";
import { callRoute as platformCallRoute, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

/** The platform call the actions make; tests pass a recording fake. */
export type CallRoute = typeof platformCallRoute;

interface BindingMutation {
  readonly accessToken: string;
  readonly changes: ToolBindingChanges;
  readonly definitionId: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export interface SaveBindingsMutation extends BindingMutation {
  readonly deploymentId: string;
  readonly expectedVersion: number;
}

export interface DeployMutation extends BindingMutation {
  readonly desiredState: "paused" | "running";
  readonly releaseId: string;
  readonly seed: { readonly deploymentId: string; readonly version: number } | undefined;
}

function bindingsChanged(operation: string): PlatformApiError {
  return new PlatformApiError(operation, {
    code: "tool_bindings_changed",
    status: 409,
    title: "Tool bindings changed since this page loaded.",
  });
}

function configProblem(operation: string, issues: readonly AgentManifestSemanticIssue[]) {
  return new PlatformApiError(operation, {
    code: "invalid_agent_deployment_config",
    detail: issues.map(({ message, path }) => `${path}: ${message}`).join("\n"),
    status: 422,
    title: "The deployment configuration does not satisfy the release.",
  });
}

function bindingKey(config: DeploymentConfig | undefined) {
  return JSON.stringify(
    Object.entries(config?.toolAuthorizations ?? {})
      .map(([tool, binding]) => [tool, binding.authorizationId, binding.toolPolicyId ?? null])
      .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

/** The deployment, or not found when it belongs to another definition than the page's. */
export async function deploymentOf(
  callRoute: CallRoute,
  accessToken: string,
  scope: EnvironmentScope,
  definitionId: string,
  deploymentId: string,
) {
  const deployment = await callRoute(
    "getAgentDeployment",
    { path: { id: deploymentId }, scope },
    accessToken,
  );
  if (deployment.agentDefinitionId !== definitionId) throw notFound();
  return deployment;
}

/** The manifests a config must satisfy, read in full on the server only. */
async function manifestsOf(
  callRoute: CallRoute,
  accessToken: string,
  scope: EnvironmentScope,
  definitionId: string,
  releaseIds: readonly string[],
) {
  const releases = await fanOut(releaseIds, (id) =>
    callRoute("getAgentRelease", { path: { id }, scope }, accessToken),
  );
  if (releases.some((release) => release.agentDefinitionId !== definitionId)) throw notFound();
  return releases.map(({ manifest }) => manifest);
}

/**
 * Applies the operator's per-tool changes to the deployment as it is now. A save whose result
 * the deployment already has (a retried submit that applied) succeeds without writing; any other
 * change since the page loaded is refused so the page reloads and rebases its choices.
 */
export async function saveToolBindings(
  mutation: SaveBindingsMutation,
  callRoute: CallRoute = platformCallRoute,
): Promise<RouteResponse<"updateAgentDeployment">> {
  const { accessToken, changes, definitionId, deploymentId, expectedVersion, scope } = mutation;
  requirePublicIds({ ...scope, definitionId, deploymentId });
  const fresh = await deploymentOf(callRoute, accessToken, scope, definitionId, deploymentId);
  if (!isRepinnable(fresh)) {
    throw new PlatformApiError("updateAgentDeployment", {
      code: "deployment_not_editable",
      status: 409,
      title: `The deployment is ${fresh.currentState}; only a ready or paused deployment can change its tool bindings.`,
    });
  }
  const releaseIds = [
    fresh.agentReleaseId,
    ...(fresh.candidateAgentReleaseId ? [fresh.candidateAgentReleaseId] : []),
  ];
  const { config, issues } = assembleRuntimeConfig({
    base: fresh.runtimeConfig,
    changes,
    manifests: await manifestsOf(callRoute, accessToken, scope, definitionId, releaseIds),
  });
  if (bindingKey(config) === bindingKey(fresh.runtimeConfig)) return fresh;
  if (fresh.version !== expectedVersion) throw bindingsChanged("updateAgentDeployment");
  if (issues.length > 0) throw configProblem("updateAgentDeployment", issues);
  return callRoute(
    "updateAgentDeployment",
    {
      body: { expectedVersion, runtimeConfig: config },
      idempotencyKey: mutation.idempotencyKey,
      path: { id: deploymentId },
      scope,
    },
    accessToken,
  );
}

/** Deploys a release with the seed deployment's config, or the default, plus the changes. */
export async function deployRelease(
  mutation: DeployMutation,
  callRoute: CallRoute = platformCallRoute,
): Promise<RouteResponse<"createAgentDeployment">> {
  const { accessToken, changes, definitionId, desiredState, releaseId, scope, seed } = mutation;
  requirePublicIds({
    ...scope,
    definitionId,
    releaseId,
    ...(seed ? { seed: seed.deploymentId } : {}),
  });
  const [manifests, seedDeployment] = await Promise.all([
    manifestsOf(callRoute, accessToken, scope, definitionId, [releaseId]),
    seed ? deploymentOf(callRoute, accessToken, scope, definitionId, seed.deploymentId) : undefined,
  ]);
  if (seed && seedDeployment?.version !== seed.version)
    throw bindingsChanged("createAgentDeployment");
  const { config, issues } = assembleRuntimeConfig({
    base: seedDeployment?.runtimeConfig,
    changes,
    manifests,
  });
  if (issues.length > 0) throw configProblem("createAgentDeployment", issues);
  return callRoute(
    "createAgentDeployment",
    {
      body: decodeRequestBody("createAgentDeployment", "CreateAgentDeploymentRequest", {
        agentReleaseId: releaseId,
        desiredState,
        runtimeConfig: config,
      }),
      idempotencyKey: mutation.idempotencyKey,
      scope,
    },
    accessToken,
  );
}
