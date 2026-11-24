import "@tanstack/react-start/server-only";
import type { AgentDeploymentResponse } from "@deployments-ai/api-contract/agents";
import {
  connectionPage,
  type CapabilityView,
  type ConnectionFilter,
  type ConnectionPage,
  type ConnectionView,
  type PinningDeploymentView,
  type VerificationView,
  type WorkspaceView,
} from "../connections/connection-state.ts";
import { PlatformApiError } from "../errors.ts";
import type { RebindObservation, RebindSearch } from "../connections/rebind.ts";
import { collectPagesUpTo } from "../overview/status-counts.ts";
import type { EnvironmentScope } from "../scope.ts";
import { loadConnectionGrants } from "./agent-runtime-data.ts";
import { requirePublicIds } from "./console-data.ts";
import { fanOut } from "./fan-out.ts";
import { API_PAGE_LIMIT } from "./list-pages.ts";
import { callRoute, collectPages } from "./platform-api.ts";

const CONNECTION_PAGE_SIZE = 25;
/** Same bound as the overview tally, so the list shows exactly the connections it counts. */
const MAX_CONNECTION_PAGES = 20;

export interface ConnectionDetail {
  readonly capabilities: readonly CapabilityView[];
  readonly connection: ConnectionView;
}

/** The environment's connections, up to the cap the overview tally also uses. */
export function walkConnections(accessToken: string, scope: EnvironmentScope) {
  return collectPagesUpTo(
    (cursor) =>
      callRoute(
        "listProviderConnections",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    MAX_CONNECTION_PAGES,
  );
}

export async function loadConnectionPage(
  accessToken: string,
  scope: EnvironmentScope,
  filter: ConnectionFilter,
  offset: number,
): Promise<ConnectionPage> {
  const { complete, items } = await walkConnections(accessToken, scope);
  return connectionPage(items, { complete, filter, offset, pageSize: CONNECTION_PAGE_SIZE });
}

function loadCapabilities(accessToken: string, scope: EnvironmentScope, connectionId: string) {
  return collectPages((cursor) =>
    callRoute(
      "listConnectionCapabilities",
      { path: { id: connectionId }, query: { cursor, limit: API_PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
}

export async function loadConnectionDetail(
  accessToken: string,
  scope: EnvironmentScope,
  connectionId: string,
): Promise<ConnectionDetail> {
  requirePublicIds({ ...scope, connectionId });
  const [connection, capabilities] = await Promise.all([
    callRoute("getProviderConnection", { path: { id: connectionId }, scope }, accessToken),
    loadCapabilities(accessToken, scope, connectionId),
  ]);
  return { capabilities, connection };
}

export async function loadConnectionVersion(
  accessToken: string,
  scope: EnvironmentScope,
  connectionId: string,
): Promise<number> {
  requirePublicIds({ ...scope, connectionId });
  const connection = await callRoute(
    "getProviderConnection",
    { path: { id: connectionId }, scope },
    accessToken,
  );
  return connection.version;
}

export function loadVerification(
  accessToken: string,
  scope: EnvironmentScope,
  verificationId: string,
): Promise<VerificationView> {
  requirePublicIds({ ...scope, verificationId });
  return callRoute(
    "getConnectionVerification",
    { path: { id: verificationId }, scope },
    accessToken,
  );
}

export function pinningView({
  agentDefinitionId,
  currentState,
  desiredState,
  id,
  runtimeConfig,
  version,
}: AgentDeploymentResponse): PinningDeploymentView {
  return {
    agentDefinitionId,
    currentState,
    desiredState,
    id,
    version,
    ...(runtimeConfig ? { runtimeConfig } : {}),
  };
}

export async function loadPinningDeployments(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<readonly PinningDeploymentView[]> {
  const deployments = await collectPages((cursor) =>
    callRoute(
      "listAgentDeployments",
      { query: { cursor, limit: API_PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
  return deployments.map(pinningView);
}

export function loadWorkspaces(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<readonly WorkspaceView[]> {
  return collectPages((cursor) =>
    callRoute("listWorkspaces", { query: { cursor, limit: API_PAGE_LIMIT }, scope }, accessToken),
  );
}

/** Which rebind the page shows: a reauthorization names its target once the callback returned. */
export interface RebindRead {
  readonly kind: RebindSearch["kind"];
  readonly targetId: string | undefined;
  readonly verificationId: string | undefined;
}

/**
 * Everything `planRebind` reads. Lists lag behind writes, so deployments that pin one of the
 * connection's grants are read again one by one with a consistent read; a re-pin the list has
 * not caught up with then plans as done instead of repeating.
 */
export async function loadRebindObservation(
  accessToken: string,
  scope: EnvironmentScope,
  connectionId: string,
  { kind, targetId, verificationId }: RebindRead,
): Promise<RebindObservation> {
  const reauthorized = kind === "reauthorize" ? targetId : undefined;
  const [{ capabilities, connection }, target, verification, grants, deployments] =
    await Promise.all([
      loadConnectionDetail(accessToken, scope, connectionId),
      reauthorized === undefined
        ? undefined
        : loadConnectionDetail(accessToken, scope, reauthorized).catch((error: unknown) => {
            // A target the environment does not have plans as a refused authorization.
            if (error instanceof PlatformApiError && error.problem.status === 404) return undefined;
            throw error;
          }),
      verificationId === undefined
        ? undefined
        : loadVerification(accessToken, scope, verificationId),
      loadConnectionGrants(accessToken, scope),
      loadPinningDeployments(accessToken, scope),
    ]);
  const grantIds = new Set<string>(
    grants.filter((grant) => grant.connectionId === connectionId).map((grant) => grant.id),
  );
  const pinning = await fanOut(deployments, async (deployment) =>
    Object.values(deployment.runtimeConfig?.toolAuthorizations ?? {}).some((binding) =>
      grantIds.has(binding.authorizationId),
    )
      ? pinningView(
          await callRoute(
            "getAgentDeployment",
            { path: { id: deployment.id }, scope },
            accessToken,
          ),
        )
      : deployment,
  );
  return {
    deployments: pinning,
    grants,
    now: new Date().toISOString(),
    old: connection,
    targetCapabilities: kind === "rotate" ? capabilities : (target?.capabilities ?? []),
    ...(target ? { target: target.connection } : {}),
    ...(verification ? { verification } : {}),
  };
}
