import { countFailedBrainErasureJobs, dueBrainErasureJobs } from "@deployments-ai/db";
import { errorLogFields } from "../error-log-fields.ts";
import { processBrainErasure, type BrainErasureRuntimeDependencies } from "./erasure-runtime.ts";

/**
 * A tick stops claiming new jobs after this long; jobs it did not reach stay due for the next
 * tick. A job it already claimed runs on, up to the Lambda timeout.
 */
const CLAIM_WINDOW_MS = 60_000;

export interface BrainErasureTickResult {
  /** Jobs that exhausted their retries and wait for an operator. */
  readonly failedJobs: number;
  /** Jobs this tick reached, counted by outcome. */
  readonly outcomes: Readonly<Record<string, number>>;
}

/**
 * Runs every due Brain erasure once, oldest due first. A job's failure is recorded on that job
 * and never stops the tick from reaching the others.
 */
export async function runBrainErasureTick(
  dependencies: BrainErasureRuntimeDependencies,
): Promise<BrainErasureTickResult> {
  const clock = dependencies.now ?? (() => new Date());
  const startedAt = clock().getTime();
  const outcomes: Record<string, number> = {};
  for (const job of await dueBrainErasureJobs(
    dependencies.database,
    new Date(startedAt).toISOString(),
  )) {
    if (clock().getTime() - startedAt >= CLAIM_WINDOW_MS) break;
    let outcome: string;
    try {
      outcome = (await processBrainErasure(job, dependencies)).outcome;
    } catch (cause) {
      console.error("Brain erasure job failed.", {
        ...errorLogFields(cause),
        brainId: job.data.brainId,
        erasureId: job.data.id,
        organizationId: job.data.organizationId,
      });
      outcome = "failed";
    }
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  return { failedJobs: await countFailedBrainErasureJobs(dependencies.database), outcomes };
}
