import type { AgentDeploymentResponse } from "@deployments-ai/api-contract/agents";
import type { ToolPolicyResponse } from "@deployments-ai/api-contract/tooling";
import { isLiveDeployment } from "../connections/connection-state.ts";

export type ToolPolicyView = typeof ToolPolicyResponse.Type;

export const POLICY_VIEWS = ["active", "all"] as const;
export type PolicyView = (typeof POLICY_VIEWS)[number];

export interface PolicySearch {
  readonly show?: "all";
}

export function parsePolicySearch(search: Readonly<Record<string, unknown>>): PolicySearch {
  return search.show === "all" ? { show: "all" } : {};
}

export interface PolicyPage {
  readonly complete: boolean;
  readonly hidden: number;
  readonly nextOffset?: number;
  readonly policies: readonly ToolPolicyView[];
}

const isActive = (policy: Pick<ToolPolicyView, "status">) => policy.status === "active";

export function policyPage(
  policies: readonly ToolPolicyView[],
  {
    complete,
    offset,
    pageSize,
    view,
  }: {
    readonly complete: boolean;
    readonly offset: number;
    readonly pageSize: number;
    readonly view: PolicyView;
  },
): PolicyPage {
  const byName = policies.toSorted(
    (left, right) =>
      Number(!isActive(left)) - Number(!isActive(right)) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  const shown = view === "active" ? byName.filter(isActive) : byName;
  const end = offset + pageSize;
  return {
    complete,
    hidden: policies.length - shown.length,
    policies: shown.slice(offset, end),
    ...(end < shown.length ? { nextOffset: end } : {}),
  };
}

export interface PolicyOptions {
  readonly complete: boolean;
  readonly items: readonly Pick<ToolPolicyView, "id" | "name">[];
}

export function policyOptions(
  policies: readonly ToolPolicyView[],
  complete: boolean,
): PolicyOptions {
  const { policies: active } = policyPage(policies, {
    complete,
    offset: 0,
    pageSize: policies.length,
    view: "active",
  });
  return { complete, items: active.map(({ id, name }) => ({ id, name })) };
}

export const POLICY_ACTIONS = ["edit", "duplicate", "archive"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export function policyActions(policy: Pick<ToolPolicyView, "status">): readonly PolicyAction[] {
  return isActive(policy) ? POLICY_ACTIONS : ["duplicate"];
}

export interface DeploymentPins {
  readonly agentDefinitionId: string;
  readonly agentName?: string;
  readonly deploymentId: string;
  readonly desiredState: AgentDeploymentResponse["desiredState"];
  readonly pins: readonly { readonly toolName: string; readonly toolPolicyId: string }[];
}

export interface PolicyPins {
  readonly complete: boolean;
  readonly deployments: readonly DeploymentPins[];
}

export function deploymentPins(
  deployment: AgentDeploymentResponse,
  agentNames: ReadonlyMap<string, string>,
): DeploymentPins {
  const agentName = agentNames.get(deployment.agentDefinitionId);
  return {
    agentDefinitionId: deployment.agentDefinitionId,
    ...(agentName === undefined ? {} : { agentName }),
    deploymentId: deployment.id,
    desiredState: deployment.desiredState,
    pins: Object.entries(deployment.runtimeConfig?.toolAuthorizations ?? {}).flatMap(
      ([toolName, binding]) =>
        binding.toolPolicyId === undefined
          ? []
          : [{ toolName, toolPolicyId: binding.toolPolicyId }],
    ),
  };
}

export interface PinningDeployment extends Omit<DeploymentPins, "desiredState" | "pins"> {
  readonly tools: readonly string[];
}

export function pinnedBy(
  policyId: string,
  deployments: readonly DeploymentPins[],
): readonly PinningDeployment[] {
  return deployments
    .filter(isLiveDeployment)
    .flatMap(({ desiredState: _state, pins, ...deployment }) => {
      const tools = pins
        .filter((pin) => pin.toolPolicyId === policyId)
        .map((pin) => pin.toolName)
        .toSorted();
      return tools.length === 0 ? [] : [{ ...deployment, tools }];
    });
}

export interface PolicyPinning {
  readonly atRisk: boolean;
  readonly known: boolean;
  readonly pinning: readonly PinningDeployment[];
}

export function policyPinning(policyId: string, pins: PolicyPins | undefined): PolicyPinning {
  const pinning = pins === undefined ? [] : pinnedBy(policyId, pins.deployments);
  const known = pins?.complete === true;
  return { atRisk: pinning.length > 0 || !known, known, pinning };
}
