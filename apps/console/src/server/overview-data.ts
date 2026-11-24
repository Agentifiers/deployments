import "@tanstack/react-start/server-only";
import {
  CONNECTION_PROBLEM_STATUSES,
  countPages,
  DEPLOYMENT_STATES,
  tallyPages,
  type CappedCount,
  type ConnectionProblemStatus,
  type DeploymentState,
  type Tally,
} from "../overview/status-counts.ts";
import type { EnvironmentScope } from "../scope.ts";
import { requirePublicIds } from "./console-data.ts";
import { callRoute } from "./platform-api.ts";

const PAGE_LIMIT = 100;
/**
 * Unfiltered lists are tallied client-side; 20 pages (2,000 resources) bounds a refresh that
 * runs every 30 seconds. Larger environments show the tally as a lower bound.
 */
const MAX_TALLY_PAGES = 20;
/** Server-filtered counts stop at one page's worth; the strip shows `100+` beyond it. */
const COUNT_CAP = 100;
/** Filtered lists can return short pages with a cursor, so following them is bounded too. */
const MAX_COUNT_PAGES = 10;

/* Page reads retry API Gateway throttling: the strip's blocks load alongside the dashboard. */

/** The environment's deployments by `currentState`. */
export function loadDeploymentStates(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<Tally<DeploymentState>> {
  requirePublicIds({ ...scope });
  return tallyPages(
    DEPLOYMENT_STATES,
    (cursor) =>
      callRoute(
        "listAgentDeployments",
        { query: { cursor, limit: PAGE_LIMIT }, scope },
        accessToken,
      ),
    (deployment) => deployment.currentState,
    MAX_TALLY_PAGES,
  );
}

/** Approvals waiting for a decision. */
export function loadPendingApprovals(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<CappedCount> {
  requirePublicIds({ ...scope });
  return countPages(
    async (cursor) => {
      const page = await callRoute(
        "listApprovals",
        { query: { cursor, limit: PAGE_LIMIT, status: "pending" }, scope },
        accessToken,
      );
      return { items: page.approvals, nextCursor: page.nextCursor };
    },
    COUNT_CAP,
    MAX_COUNT_PAGES,
  );
}

/** Provider connections in `error` or `reauthorization-required` (the list has no filter). */
export function loadConnectionProblems(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<Tally<ConnectionProblemStatus>> {
  requirePublicIds({ ...scope });
  return tallyPages(
    CONNECTION_PROBLEM_STATUSES,
    (cursor) =>
      callRoute(
        "listProviderConnections",
        { query: { cursor, limit: PAGE_LIMIT }, scope },
        accessToken,
      ),
    (connection) => connection.status,
    MAX_TALLY_PAGES,
  );
}

/** Webhook deliveries in `failed`. */
export function loadFailedDeliveries(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<CappedCount> {
  requirePublicIds({ ...scope });
  return countPages(
    async (cursor) => {
      const page = await callRoute(
        "listWebhookDeliveries",
        { query: { cursor, limit: PAGE_LIMIT, status: "failed" }, scope },
        accessToken,
      );
      return { items: page.deliveries, nextCursor: page.nextCursor };
    },
    COUNT_CAP,
    MAX_COUNT_PAGES,
  );
}
