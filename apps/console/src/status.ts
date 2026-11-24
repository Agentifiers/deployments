import type { EnvironmentResponse } from "@deployments-ai/api-contract";

type EnvironmentType = EnvironmentResponse["type"];

export type BadgeColor = "amber" | "blue" | "green" | "indigo" | "red" | "sky" | "zinc";

/** Status colors from the console conventions; unknown values render neutral. */
export const STATUS_COLORS: Readonly<Record<string, BadgeColor>> = {
  "account-disabled": "zinc",
  accepted: "green",
  active: "green",
  allow: "green",
  allowed: "green",
  approved: "green",
  archived: "zinc",
  available: "green",
  bounced: "red",
  canceled: "zinc",
  canceling: "blue",
  cancelled: "zinc",
  complained: "red",
  completed: "green",
  consumed: "green",
  created: "green",
  degraded: "amber",
  deleted: "zinc",
  delivered: "green",
  deploying: "blue",
  deny: "red",
  denied: "red",
  deprovisioning: "blue",
  disabled: "zinc",
  disconnected: "zinc",
  dispatched: "blue",
  draft: "zinc",
  enabled: "green",
  erasing: "blue",
  error: "red",
  executing: "blue",
  expired: "zinc",
  fail: "red",
  failed: "red",
  healthy: "green",
  invited: "blue",
  issued: "blue",
  merged: "green",
  ok: "green",
  "over-limit": "amber",
  open: "amber",
  pass: "green",
  paused: "amber",
  pending: "blue",
  pending_approval: "amber",
  pending_dns: "amber",
  provisioning: "blue",
  published: "green",
  queued: "blue",
  ready: "green",
  "reauthorization-required": "amber",
  received: "green",
  reconciling: "blue",
  reinstated: "green",
  released: "zinc",
  resolved: "green",
  removed: "zinc",
  require_approval: "amber",
  refusing: "red",
  rejected: "red",
  retrying: "amber",
  revoked: "zinc",
  running: "blue",
  scheduled: "blue",
  scored: "green",
  sending: "blue",
  sent: "green",
  skipped: "zinc",
  stale: "amber",
  stopped: "zinc",
  streaming: "blue",
  submitted: "blue",
  succeeded: "green",
  superseded: "zinc",
  suppressed: "zinc",
  suspended: "red",
  timed_out: "red",
  unavailable: "red",
  unchanged: "zinc",
  unknown: "zinc",
  unreviewed: "zinc",
  unverified: "amber",
  updated: "blue",
  verified: "green",
  waiting: "amber",
  "waiting-for-agent": "amber",
  "waiting-for-approval": "amber",
  "waiting-for-delivery": "amber",
  "waiting-for-tool": "amber",
};

export function statusColor(status: string): BadgeColor {
  return STATUS_COLORS[status] ?? (status.startsWith("waiting-for-") ? "amber" : "zinc");
}

/** Labels that sentence-casing the API value would get wrong. */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  "account-disabled": "Account disabled",
  ok: "OK",
  pending_dns: "Pending DNS",
  require_approval: "Requires approval",
};

/** The API value as words a customer reads, such as "Reauthorization required". */
export function statusLabel(status: string): string {
  const label = STATUS_LABELS[status];
  if (label !== undefined) return label;
  const words = status.replaceAll(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Production stands out on purpose, since the badge stays visible on every production page, but
 * in indigo, a color no status uses, so it never reads as a failure.
 */
export const ENVIRONMENT_TYPE_COLORS: Readonly<Record<EnvironmentType, BadgeColor>> = {
  custom: "zinc",
  development: "sky",
  production: "indigo",
  staging: "amber",
};
