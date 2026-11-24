import { formatExact } from "../observability/format.ts";
import type { GrantFilter, MemoryPolicy } from "./model.ts";

export function policyReach(policy: Pick<MemoryPolicy, "scope" | "workspaceId">): string {
  switch (policy.scope) {
    case "workspace":
      return `Applies only to agents in workspace ${policy.workspaceId ?? "(unknown)"}.`;
    case "environment":
      return "Applies to every agent in this environment, except in workspaces with their own policy.";
    case "organization":
      return "Applies in this environment only where no environment or workspace policy exists.";
  }
}

/**
 * A memory takes the retention of its effective policy (workspace, then environment, then
 * organization), or else its space's, so the warning compares what governs before and after.
 */
export function retentionWarning({
  current,
  next,
  policies,
  scope,
}: {
  readonly current: Pick<MemoryPolicy, "retentionDays"> | undefined;
  readonly next: number | undefined;
  readonly policies: readonly Pick<MemoryPolicy, "retentionDays" | "scope">[];
  readonly scope: MemoryPolicy["scope"];
}): string | undefined {
  if (scope === "organization" && policies.some((policy) => policy.scope === "environment")) {
    return undefined;
  }
  const before = current
    ? current.retentionDays
    : scope === "environment"
      ? policies.find((policy) => policy.scope === "organization")?.retentionDays
      : undefined;
  if (next === undefined) {
    return before === undefined
      ? undefined
      : `The memories this policy reaches leave the ${before}-day retention they have now and fall back to their space's retention. Those older than their space's retention, counted from when each was created, will be permanently deleted.`;
  }
  if (before === undefined) {
    return `Memories this policy reaches that are older than ${next} days, counted from when each was created, will be permanently deleted, whatever their space's retention.`;
  }
  return next < before
    ? `Retention for the memories this policy reaches drops from ${before} to ${next} days. Those older than ${next} days, counted from when each was created, will be permanently deleted.`
    : undefined;
}

export const GRANT_EMPTY_TITLES: Readonly<Record<GrantFilter, string>> = {
  active: "No active grants",
  all: "No agent grants",
  revoked: "No revoked grants",
};

/** Why a memory went to review, as the platform names it. Unknown kinds show their raw name. */
const REVIEW_KIND_LABELS: Readonly<Record<string, string>> = {
  "broad-scope": "Shared widely",
  "content-governance": "Sensitive content",
  "sampled-import": "Import spot check",
  supersession: "Replaces another memory",
};

export function reviewKindLabel(kind: string): string {
  return REVIEW_KIND_LABELS[kind] ?? kind;
}

/** Retrieval strategies in words. Unknown strategies show their raw name. */
const STRATEGY_LABELS: Readonly<Record<string, string>> = {
  "dense-exact-control-v1": "Semantic, exact (control)",
  "dense-open-search-ann-control-v1": "Semantic, approximate (control)",
  "dense-v1": "Semantic",
  "hybrid-rerank-v1": "Hybrid with reranking",
  "hybrid-rrf-v1": "Hybrid",
};

export function strategyLabel(strategy: string): string {
  return STRATEGY_LABELS[strategy] ?? strategy;
}

/** Attempts neither completed nor failed were skipped, for example when nothing was stored yet. */
export function attemptBreakdown(counts: {
  readonly attempts: number;
  readonly completed: number;
  readonly failed: number;
}): string {
  const skipped = counts.attempts - counts.completed - counts.failed;
  const parts = [
    `${formatExact(counts.completed)} completed`,
    `${formatExact(counts.failed)} failed`,
  ];
  if (skipped > 0) parts.push(`${formatExact(skipped)} skipped`);
  return parts.join(", ");
}
