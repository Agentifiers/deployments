/* eslint-disable no-await-in-loop -- Runtime side effects must preserve agent-request order. */

import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeDependencies,
} from "./types.ts";
import { executeAgentRunImpl } from "./runtime-sandbox.ts";

export function createAgentRuntime(dependencies: AgentRuntimeDependencies): AgentRuntime {
  return { execute: (input) => executeAgentRunImpl(input, dependencies) };
}

export function executeAgentRun(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
): Promise<AgentRunResult> {
  return executeAgentRunImpl(input, dependencies);
}
