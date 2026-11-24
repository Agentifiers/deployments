import {
  RETENTION_CLASSES,
  type RetentionPolicy,
  type StoredRetentionPolicy,
} from "@deployments-ai/db";

/**
 * Retention for the long-lived credentialed E2E organization. Every credentialed run creates
 * fresh threads, runs, messages, events, and artifacts there, and the 365-day product default
 * would keep each run's records for a year. A week keeps recent evidence while the daily
 * retention sweep removes older runs. Audit stays at the product minimum of 365 days.
 */
export const E2E_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  artifacts: 7,
  audit: 365,
  events: 7,
  messages: 7,
  runs: 7,
  threads: 7,
});

/** The policy write that applies `E2E_RETENTION_POLICY`, or `undefined` when it already holds. */
export function e2eRetentionPolicyPlan(input: {
  readonly current: StoredRetentionPolicy | undefined;
  readonly now: string;
  readonly organizationId: string;
  readonly principalId: string;
}): { readonly policy: StoredRetentionPolicy; readonly previousVersion?: number } | undefined {
  const { current } = input;
  if (current && RETENTION_CLASSES.every((name) => current[name] === E2E_RETENTION_POLICY[name])) {
    return undefined;
  }
  return {
    policy: {
      ...E2E_RETENTION_POLICY,
      createdAt: current?.createdAt ?? input.now,
      organizationId: input.organizationId,
      updatedAt: input.now,
      updatedByPrincipalId: input.principalId,
      version: (current?.version ?? 0) + 1,
    },
    ...(current ? { previousVersion: current.version } : {}),
  };
}
