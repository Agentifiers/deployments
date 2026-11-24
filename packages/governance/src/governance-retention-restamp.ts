import {
  DEFAULT_RETENTION_POLICY,
  RETENTION_TTL_GRACE_SECONDS,
  type GovernanceStore,
  type RetentionRestamp,
  type RetentionRestampStore,
} from "@deployments-ai/db";

/** How long a claimed restamp stays hidden from the dispatch sweep; a crashed run resumes after. */
export const RETENTION_RESTAMP_LEASE_MILLISECONDS = 15 * 60_000;
// Leaves a 900 s governance worker invocation time to write its last checkpoint.
const RETENTION_RESTAMP_RUN_MILLISECONDS = 10 * 60_000;

export type RetentionRestampOutcome = "completed" | "none" | "superseded" | "waiting" | "yielded";

/**
 * Raises an organization's item TTLs to its current retention policy after a period got longer:
 * first every TTL that falls within the grace, then the rest. Each page checkpoints the cursor
 * and renews the lease, so a crash resumes from the last page; a newer lengthening replaces the
 * restamp and this run stops.
 */
export function makeRetentionRestampRunner(input: {
  readonly now: () => Date;
  readonly store: RetentionRestampStore & Pick<GovernanceStore, "getRetentionPolicy">;
}) {
  const { now, store } = input;
  const leased = (restamp: RetentionRestamp, at: Date, dueAt = at) => ({
    ...restamp,
    dueAt: new Date(dueAt.getTime()).toISOString(),
    updatedAt: at.toISOString(),
    version: restamp.version + 1,
  });
  return async (
    organizationId: string,
  ): Promise<{ readonly outcome: RetentionRestampOutcome; readonly restamped: number }> => {
    const startedAt = now();
    const pending = await store.getRetentionRestamp(organizationId);
    if (!pending) return { outcome: "none", restamped: 0 };
    if (Date.parse(pending.dueAt) > startedAt.getTime())
      return { outcome: "waiting", restamped: 0 };
    let restamp = leased(
      pending,
      startedAt,
      new Date(startedAt.getTime() + RETENTION_RESTAMP_LEASE_MILLISECONDS),
    );
    if (!(await store.putRetentionRestamp(restamp, pending.version))) {
      return { outcome: "superseded", restamped: 0 };
    }
    const policy = (await store.getRetentionPolicy(organizationId)) ?? DEFAULT_RETENTION_POLICY;
    let restamped = 0;
    while (now().getTime() - startedAt.getTime() < RETENTION_RESTAMP_RUN_MILLISECONDS) {
      const page = await store.restampRetentionTtlPage(organizationId, {
        cursor: restamp.cursor,
        expiringBefore:
          restamp.phase === "soonest"
            ? Math.floor(now().getTime() / 1_000) + RETENTION_TTL_GRACE_SECONDS
            : undefined,
        policy,
      });
      restamped += page.restamped;
      if (!page.cursor && restamp.phase === "all") {
        return {
          outcome: (await store.deleteRetentionRestamp(restamp)) ? "completed" : "superseded",
          restamped,
        };
      }
      const { cursor: _cursor, ...uncursored } = restamp;
      const advanced: RetentionRestamp = page.cursor
        ? { ...restamp, cursor: page.cursor }
        : { ...uncursored, phase: "all" };
      const checkpointAt = now();
      const checkpoint = leased(
        advanced,
        checkpointAt,
        new Date(checkpointAt.getTime() + RETENTION_RESTAMP_LEASE_MILLISECONDS),
      );
      if (!(await store.putRetentionRestamp(checkpoint, restamp.version))) {
        return { outcome: "superseded", restamped };
      }
      restamp = checkpoint;
    }
    // Due now, so the next dispatch sweep continues from the checkpoint.
    const yieldedAt = now();
    return {
      outcome: (await store.putRetentionRestamp(leased(restamp, yieldedAt), restamp.version))
        ? "yielded"
        : "superseded",
      restamped,
    };
  };
}
