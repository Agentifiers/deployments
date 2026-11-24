import type { PlatformProblem } from "../errors.ts";

/** `getRunMessage` conflicts that mean the run has no final message to show, not a failure. */
const NO_OUTPUT_CODES: Readonly<Record<string, true>> = {
  run_message_unavailable: true,
  run_not_completed: true,
};

/** Whether a failed `getRunMessage` hides the Output section instead of showing the problem. */
export function hidesRunOutput(problem: Pick<PlatformProblem, "code" | "status">): boolean {
  if (problem.status === 404) return true;
  return (
    problem.status === 409 && problem.code !== undefined && NO_OUTPUT_CODES[problem.code] === true
  );
}
