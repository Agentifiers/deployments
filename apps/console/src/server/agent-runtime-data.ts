import "@tanstack/react-start/server-only";
import {
  RUN_PAGE_SIZE,
  type RunStreamPage,
  type RunStreamRequest,
} from "../components/agents/runtime/run-merge.ts";
import { PlatformApiError, type PlatformProblem } from "../errors.ts";
import type { RunFilters } from "../runs/filters.ts";
import type { EnvironmentScope } from "../scope.ts";
import { consoleConfig } from "./config.ts";
import { fanOut } from "./fan-out.ts";
import { callRoute, collectPages, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";
import type { Run } from "./runtime-data.ts";

const PAGE_LIMIT = 100;
/** Pages of the environment's deliveries read per tab load; busy environments show the newest. */
const DELIVERY_PAGES = 5;

type ToolEvaluation = RouteResponse<"evaluateToolPolicy">["results"][number];
/** Channel bindings without their free-form `metadata`, which the tab does not show. */
export type ChannelBinding = Omit<
  RouteResponse<"listChannelBindings">["channelBindings"][number],
  "metadata"
>;
export type ChannelDelivery = RouteResponse<"listChannelDeliveries">["channelDeliveries"][number];

export interface AgentChannels {
  readonly bindings: readonly ChannelBinding[];
  /** Deliveries through `bindings`, newest first. */
  readonly deliveries: readonly ChannelDelivery[];
  /** False when the environment had more deliveries than were read. */
  readonly deliveriesComplete: boolean;
  /** Channel API origin that serves binding ingress; absent when the install runs none. */
  readonly ingressOrigin?: string;
}
type AgentEmailInbox = RouteResponse<"listAgentEmailInboxes">["items"][number];
type AgentEmailBinding = RouteResponse<"listAgentEmailBindings">["items"][number];

/** One deployment's effective tools, or the problem its evaluation returned. */
export type DeploymentToolEvaluation =
  | {
      readonly agentReleaseId: string | undefined;
      readonly deploymentId: string;
      readonly results: readonly ToolEvaluation[];
    }
  | { readonly deploymentId: string; readonly problem: PlatformProblem };

/** An inbox with its bindings that route to the agent's deployments. */
export interface RoutedInbox {
  readonly bindings: readonly AgentEmailBinding[];
  readonly inbox: AgentEmailInbox;
}

/** The next page of each requested deployment's runs. */
export function loadRunPages(
  accessToken: string,
  scope: EnvironmentScope,
  requests: readonly RunStreamRequest[],
  filters: RunFilters,
): Promise<RunStreamPage<Run>[]> {
  return fanOut(requests, async ({ cursor, deploymentId }) => {
    const page = await callRoute(
      "listRuns",
      {
        query: {
          agentDeploymentId: deploymentId,
          cursor,
          executionPurpose: filters.executionPurpose,
          limit: RUN_PAGE_SIZE,
          status: filters.status,
        },
        scope,
      },
      accessToken,
    );
    return { deploymentId, nextCursor: page.nextCursor, runs: page.runs };
  });
}

/**
 * Each deployment's pinned tools through `POST /v1/tool-policies/evaluate` (a read without side
 * effects). A deployment whose evaluation fails reports its problem without hiding the others.
 */
export function loadToolEvaluations(
  accessToken: string,
  scope: EnvironmentScope,
  deploymentIds: readonly string[],
): Promise<DeploymentToolEvaluation[]> {
  return fanOut(deploymentIds, async (deploymentId): Promise<DeploymentToolEvaluation> => {
    try {
      const evaluation = await callRoute(
        "evaluateToolPolicy",
        {
          body: decodeRequestBody("evaluateToolPolicy", "EvaluateToolPolicyRequest", {
            agentDeploymentId: deploymentId,
          }),
          scope,
        },
        accessToken,
      );
      return {
        agentReleaseId: evaluation.agentReleaseId,
        deploymentId,
        results: evaluation.results,
      };
    } catch (error) {
      if (error instanceof PlatformApiError) return { deploymentId, problem: error.problem };
      throw error;
    }
  });
}

export function loadConnectionGrants(accessToken: string, scope: EnvironmentScope) {
  return collectPages((cursor) =>
    callRoute("listConnectionGrants", { query: { cursor, limit: PAGE_LIMIT }, scope }, accessToken),
  );
}

/**
 * The agent's channel bindings, each binding's ingress URL when the install runs channel ingress,
 * and the newest deliveries through them. Neither list has an agent filter: the environment's
 * bindings are paged in full and kept when they name the definition or one of its deployments;
 * deliveries are read for at most `DELIVERY_PAGES` pages and kept when they went through one of
 * those bindings.
 */
export async function loadAgentChannels(
  accessToken: string,
  scope: EnvironmentScope,
  definitionId: string,
  deploymentIds: readonly string[],
): Promise<AgentChannels> {
  const deployments = new Set(deploymentIds);
  const [bindings, deliveries] = await Promise.all([
    collectPages(async (cursor) => {
      const page = await callRoute(
        "listChannelBindings",
        { query: { cursor, limit: PAGE_LIMIT }, scope },
        accessToken,
      );
      return { items: page.channelBindings, nextCursor: page.nextCursor };
    }),
    readDeliveries(accessToken, scope),
  ]);
  const kept = bindings
    .filter(
      (binding) =>
        binding.agentDefinitionId === definitionId ||
        (binding.agentDeploymentId !== undefined && deployments.has(binding.agentDeploymentId)),
    )
    .map(({ metadata: _metadata, ...binding }) => binding);
  const ids = new Set(kept.map((binding) => binding.id));
  const { oauthCallbackOrigin } = consoleConfig();
  return {
    bindings: kept,
    deliveries: deliveries.items
      .filter((delivery) => delivery.bindingId !== undefined && ids.has(delivery.bindingId))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
    deliveriesComplete: deliveries.complete,
    ...(oauthCallbackOrigin ? { ingressOrigin: oauthCallbackOrigin } : {}),
  };
}

async function readDeliveries(accessToken: string, scope: EnvironmentScope) {
  const items: ChannelDelivery[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < DELIVERY_PAGES; page += 1) {
    const result = await callRoute(
      "listChannelDeliveries",
      { query: { cursor, limit: PAGE_LIMIT }, scope },
      accessToken,
    );
    items.push(...result.channelDeliveries);
    cursor = result.nextCursor ?? undefined;
    if (cursor === undefined) return { complete: true, items };
  }
  return { complete: false, items };
}

/** One delivery as the API holds it now, for a delivery still queued or sending. */
export function loadChannelDelivery(
  accessToken: string,
  scope: EnvironmentScope,
  runId: string,
  deliveryId: string,
): Promise<ChannelDelivery> {
  return callRoute("getChannelDelivery", { path: { deliveryId, runId }, scope }, accessToken);
}

/** Inbox statuses that can still deliver mail; archived inboxes route nothing. */
const ROUTABLE_INBOX_STATUSES = ["active", "paused"] as const;

/**
 * Inboxes that are not archived and have a binding to one of the agent's deployments. Bindings
 * are listed per inbox, so each routable inbox's bindings are read; inboxes without a matching
 * binding are dropped.
 */
export async function loadAgentEmailRoutes(
  accessToken: string,
  scope: EnvironmentScope,
  deploymentIds: readonly string[],
): Promise<RoutedInbox[]> {
  const deployments = new Set(deploymentIds);
  const inboxes = (
    await Promise.all(
      ROUTABLE_INBOX_STATUSES.map((status) =>
        collectPages((cursor) =>
          callRoute(
            "listAgentEmailInboxes",
            { query: { cursor, limit: PAGE_LIMIT, status }, scope },
            accessToken,
          ),
        ),
      ),
    )
  ).flat();
  const routed = await fanOut(inboxes, async (inbox) => {
    const bindings = await collectPages((cursor) =>
      callRoute(
        "listAgentEmailBindings",
        { path: { inboxId: inbox.id }, query: { cursor, limit: PAGE_LIMIT }, scope },
        accessToken,
      ),
    );
    return {
      bindings: bindings.filter(
        (binding) =>
          binding.agentDeploymentId !== undefined && deployments.has(binding.agentDeploymentId),
      ),
      inbox,
    };
  });
  return routed.filter((entry) => entry.bindings.length > 0);
}
