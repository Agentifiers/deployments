import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { SCOPE_FIELDS, scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadConnectionProblems,
  loadDeploymentStates,
  loadFailedDeliveries,
  loadPendingApprovals,
} from "../server/overview-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { STATUS_REFRESH_MS } from "./refresh.ts";
import { requireIds } from "./server-input.ts";

const fetchDeploymentStates = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadDeploymentStates(await requireAccessToken(), data));

const fetchPendingApprovals = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadPendingApprovals(await requireAccessToken(), data));

const fetchConnectionProblems = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadConnectionProblems(await requireAccessToken(), data));

const fetchFailedDeliveries = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadFailedDeliveries(await requireAccessToken(), data));

/* Each strip block is its own query, so one failing source leaves the others rendering. */

export const deploymentStatesQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchDeploymentStates({ data: scope }),
    queryKey: ["overview-deployment-states", ...scopeKey(scope)],
    refetchInterval: STATUS_REFRESH_MS,
  });

export const pendingApprovalsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchPendingApprovals({ data: scope }),
    queryKey: ["overview-pending-approvals", ...scopeKey(scope)],
    refetchInterval: STATUS_REFRESH_MS,
  });

export const connectionProblemsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchConnectionProblems({ data: scope }),
    queryKey: ["overview-connection-problems", ...scopeKey(scope)],
    refetchInterval: STATUS_REFRESH_MS,
  });

export const failedDeliveriesQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchFailedDeliveries({ data: scope }),
    queryKey: ["overview-failed-deliveries", ...scopeKey(scope)],
    refetchInterval: STATUS_REFRESH_MS,
  });
