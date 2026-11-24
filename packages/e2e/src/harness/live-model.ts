import { E2eConfigurationError } from "./errors.ts";

type LiveAgentModelRuntime =
  | { readonly modelInputTokenBudget?: never; readonly modelOutputTokenReserve?: never }
  | { readonly modelInputTokenBudget: number; readonly modelOutputTokenReserve: number };

export interface LiveAgentModel {
  readonly model: { readonly id: string };
  readonly runtime: LiveAgentModelRuntime;
}

const INPUT_TOKEN_BUDGET = "DEPLOYMENTS_E2E_AGENT_MODEL_INPUT_TOKEN_BUDGET";
const OUTPUT_TOKEN_RESERVE = "DEPLOYMENTS_E2E_AGENT_MODEL_OUTPUT_TOKEN_RESERVE";
/** A curated model, which every organization admits without a policy or grant. */
const DEFAULT_AGENT_MODEL_ID = "openrouter/qwen/qwen3.7-plus";

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new E2eConfigurationError({ message: `${name} must be a positive integer.` });
  }
  return parsed;
}

export function parseLiveAgentModel(
  env: Readonly<Record<string, string | undefined>>,
): LiveAgentModel {
  const value = (name: string) => env[name]?.trim() || undefined;
  const model = { id: value("DEPLOYMENTS_E2E_AGENT_MODEL") ?? DEFAULT_AGENT_MODEL_ID };
  const inputTokenBudget = value(INPUT_TOKEN_BUDGET);
  const outputTokenReserve = value(OUTPUT_TOKEN_RESERVE);
  if (inputTokenBudget === undefined && outputTokenReserve === undefined) {
    return { model, runtime: {} };
  }
  if (inputTokenBudget === undefined || outputTokenReserve === undefined) {
    throw new E2eConfigurationError({
      message: `Set both ${INPUT_TOKEN_BUDGET} and ${OUTPUT_TOKEN_RESERVE}, or neither.`,
    });
  }
  return {
    model,
    runtime: {
      modelInputTokenBudget: positiveInteger(INPUT_TOKEN_BUDGET, inputTokenBudget),
      modelOutputTokenReserve: positiveInteger(OUTPUT_TOKEN_RESERVE, outputTokenReserve),
    },
  };
}

/**
 * The agent model and its runtime budgets for every live agent, including those in disposable
 * organizations; a deployment-wide operator grant admits a relayed model in each organization.
 */
export const liveAgentModel = parseLiveAgentModel(process.env);
