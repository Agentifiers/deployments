import "@tanstack/react-start/server-only";
import { collectPagesUpTo } from "../overview/status-counts.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  deploymentPins,
  policyOptions,
  policyPage,
  type PolicyOptions,
  type PolicyPage,
  type PolicyPins,
  type PolicyView,
  type ToolPolicyView,
} from "../tool-policies/policy-state.ts";
import type { SimulationInput } from "../tool-policies/simulator-state.ts";
import { API_PAGE_LIMIT } from "./list-pages.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

const POLICY_PAGE_SIZE = 25;
const MAX_LIST_PAGES = 20;

function walkPolicies(accessToken: string, scope: EnvironmentScope) {
  return collectPagesUpTo(
    (cursor) =>
      callRoute(
        "listToolPolicies",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    MAX_LIST_PAGES,
  );
}

export async function loadPolicyPage(
  accessToken: string,
  scope: EnvironmentScope,
  view: PolicyView,
  offset: number,
): Promise<PolicyPage> {
  const { complete, items } = await walkPolicies(accessToken, scope);
  return policyPage(items, { complete, offset, pageSize: POLICY_PAGE_SIZE, view });
}

export async function loadPolicyOptions(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<PolicyOptions> {
  const { complete, items } = await walkPolicies(accessToken, scope);
  return policyOptions(items, complete);
}

export function loadPolicy(
  accessToken: string,
  scope: EnvironmentScope,
  policyId: string,
): Promise<ToolPolicyView> {
  return callRoute("getToolPolicy", { path: { id: policyId }, scope }, accessToken);
}

export async function loadPolicyPins(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<PolicyPins> {
  const [deployments, definitions] = await Promise.all([
    collectPagesUpTo(
      (cursor) =>
        callRoute(
          "listAgentDeployments",
          { query: { cursor, limit: API_PAGE_LIMIT }, scope },
          accessToken,
        ),
      MAX_LIST_PAGES,
    ),
    collectPagesUpTo(
      (cursor) =>
        callRoute(
          "listAgentDefinitions",
          { query: { cursor, limit: API_PAGE_LIMIT }, scope },
          accessToken,
        ),
      MAX_LIST_PAGES,
    ),
  ]);
  const names = new Map(definitions.items.map(({ id, name }) => [id, name]));
  return {
    complete: deployments.complete,
    deployments: deployments.items.map((deployment) => deploymentPins(deployment, names)),
  };
}
export function loadSimulation(
  accessToken: string,
  scope: EnvironmentScope,
  { kind: _kind, ...body }: SimulationInput,
): Promise<RouteResponse<"evaluateToolPolicy">> {
  return callRoute(
    "evaluateToolPolicy",
    { body: decodeRequestBody("evaluateToolPolicy", "EvaluateToolPolicyRequest", body), scope },
    accessToken,
  );
}
