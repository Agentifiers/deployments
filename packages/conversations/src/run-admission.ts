import {
  findExhaustedBudget,
  makeOrganizationHoldReader,
  type UsageScope,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { admitConsistently } from "@deployments-ai/organization-admission";
import { ConversationError } from "./submission.ts";

/**
 * Refusals of a new run that redelivering the same submission cannot change. Schedules,
 * heartbeats, channel ingress, and inbound email settle these instead of retrying.
 */
export const RUN_REFUSAL_CODES = ["budget_exhausted", "organization_suspended"] as const;
export type RunRefusalCode = (typeof RUN_REFUSAL_CODES)[number];

export function isRunRefusalCode(code: string): code is RunRefusalCode {
  return RUN_REFUSAL_CODES.some((refusal) => refusal === code);
}

export function isRunRefusal(
  cause: unknown,
): cause is ConversationError & { readonly code: RunRefusalCode } {
  return cause instanceof ConversationError && isRunRefusalCode(cause.code);
}

/**
 * Refuses a new run while its organization is suspended, then while an active budget governing its
 * workspace, environment, project, or organization has spent its amount for the current period.
 * `scope` is the scope the run executes in, including a workspace it inherits from its thread.
 * Runs already admitted are not affected, so callers check after idempotent-replay reconciliation
 * and before persisting the new run. Standing is read strongly consistently: a failed read refuses
 * with the retryable `organization_standing_unavailable`, never as a suspension.
 */
export async function assertRunAdmissible(
  database: DynamoDatabaseService,
  scope: UsageScope,
  at: Date,
): Promise<void> {
  const { decision } = await admitConsistently({
    activity: "run.admit",
    organizationId: scope.organizationId,
    standing: makeOrganizationHoldReader(database),
  }).catch((cause: unknown) => {
    throw new ConversationError(
      "organization_standing_unavailable",
      "The organization's standing could not be read; retry the request.",
      { cause },
    );
  });
  if (decision.kind === "suspended") {
    throw new ConversationError(
      "organization_suspended",
      "The organization is suspended; new runs are refused until every hold is released.",
    );
  }
  const exhaustion = await findExhaustedBudget(database, scope, at);
  if (!exhaustion) return;
  const budget = exhaustion.budget.data;
  const percent = Math.floor((exhaustion.spendUsdMicros * 100) / budget.amountUsdMicros);
  throw new ConversationError(
    "budget_exhausted",
    `Budget "${budget.name}" (${budget.id}) for the ${budget.scope} has reached ${percent}% of ` +
      `its ${budget.period} limit for the period starting ${exhaustion.periodStart}; new runs ` +
      "are refused until the period ends or the budget is raised, paused, or archived.",
  );
}
