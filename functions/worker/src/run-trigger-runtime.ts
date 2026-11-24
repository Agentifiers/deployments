import type { AgentResponseDepthPolicy } from "@deployments-ai/agent-manifest";

const SCHEDULE_CREATION_MODEL_TOOLS = new Set(["agent.schedule.create", "agent.schedule.remind"]);

const SCHEDULE_EXECUTION_INSTRUCTIONS = [
  "Scheduled run execution:",
  "This run started because a previously created schedule is due now.",
  "Fulfill the current prompt now in the final response.",
  "Do not merely acknowledge the scheduled task.",
  "Do not create another schedule or reminder during this run.",
].join("\n");

export function runtimeInstructionsForTrigger(instructions: string, trigger: string): string {
  if (trigger !== "schedule") return instructions;
  return `${instructions}\n\n${SCHEDULE_EXECUTION_INSTRUCTIONS}`;
}

export function runtimeModelToolNamesForTrigger(
  modelToolNames: readonly string[],
  trigger: string,
): readonly string[] {
  if (trigger !== "schedule") return modelToolNames;
  // Release-pinned tool requests remain explicit workflow behavior. Only autonomous model
  // selection is fenced so a due one-shot task cannot recursively re-arm itself.
  return modelToolNames.filter((toolName) => !SCHEDULE_CREATION_MODEL_TOOLS.has(toolName));
}

export function runtimeResponseDepthPolicyForTrigger(
  policy: AgentResponseDepthPolicy | undefined,
  trigger: string,
): AgentResponseDepthPolicy | undefined {
  return trigger === "heartbeat" || trigger === "schedule" ? undefined : policy;
}
