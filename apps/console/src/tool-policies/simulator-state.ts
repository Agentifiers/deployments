import { AgentToolName } from "@deployments-ai/agent-manifest/schema";
import { TOOL_POLICY_EVALUATION_MAX_TOOLS } from "@deployments-ai/api-contract/tool-catalog";
import { Schema } from "effect";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const isToolName = Schema.is(AgentToolName);

export type SimulationInput =
  | {
      readonly kind: "policy";
      readonly toolNames: readonly [string, ...string[]];
      readonly toolPolicyId: string;
    }
  | { readonly agentDeploymentId: string; readonly kind: "deployment" };

export type SimulationTarget = SimulationInput["kind"];

export interface SimulationSearch {
  readonly against: SimulationTarget;
  readonly deployment?: string;
  readonly policy?: string;
  readonly tools: readonly string[];
}

export interface ToolNameList {
  readonly invalid: readonly string[];
  readonly names: readonly string[];
  readonly tooMany: boolean;
}

export function parseToolNames(text: string): ToolNameList {
  const entries = [...new Set(text.split(/[\s,]+/u).filter((entry) => entry !== ""))];
  const names = entries.filter(isToolName);
  return {
    invalid: entries.filter((entry) => !isToolName(entry)),
    names,
    tooMany: names.length > TOOL_POLICY_EVALUATION_MAX_TOOLS,
  };
}

const ulid = (value: unknown) =>
  typeof value === "string" && ULID.test(value) ? value : undefined;

export function parseSimulationSearch(search: Readonly<Record<string, unknown>>): SimulationSearch {
  const { tools } = search;
  const policy = ulid(search.policy);
  const deployment = ulid(search.deployment);
  const names = Array.isArray(tools)
    ? [...new Set(tools.filter((tool): tool is string => isToolName(tool)))].slice(
        0,
        TOOL_POLICY_EVALUATION_MAX_TOOLS,
      )
    : [];
  return {
    against: search.against === "deployment" ? "deployment" : "policy",
    ...(deployment === undefined ? {} : { deployment }),
    ...(policy === undefined ? {} : { policy }),
    tools: names,
  };
}

export function simulationInput(search: SimulationSearch): SimulationInput | undefined {
  if (search.against === "deployment") {
    return search.deployment === undefined
      ? undefined
      : { agentDeploymentId: search.deployment, kind: "deployment" };
  }
  const [first, ...rest] = search.tools;
  return search.policy === undefined || first === undefined
    ? undefined
    : { kind: "policy", toolNames: [first, ...rest], toolPolicyId: search.policy };
}
