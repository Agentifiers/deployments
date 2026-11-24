import type { RuntimeToolExecutionResult } from "@deployments-ai/agent-runtime";
import { SandboxCapacityError } from "@deployments-ai/sandbox-hosts";

const ORGANIZATION_SANDBOX_LIMIT_REACHED = "organization_sandbox_limit_reached";

export function sandboxCapacityRefusal(
  toolName: string,
  cause: unknown,
): RuntimeToolExecutionResult | undefined {
  const seen = new Set<unknown>();
  let current = cause;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof SandboxCapacityError) {
      const message = `This organization reached its limit of ${current.limit} active sandboxes, so ${toolName} did not run. Try again after other sandbox work finishes, or continue without it.`;
      return {
        output: {
          error: { code: ORGANIZATION_SANDBOX_LIMIT_REACHED, limit: current.limit, message },
        },
        outputSummary: `Tool ${toolName} failed: ${message}`,
        status: "completed",
      };
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}
