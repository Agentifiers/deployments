import type {
  OrganizationRetentionPolicyResponse,
  UpdateOrganizationRetentionPolicyRequest,
} from "@deployments-ai/api-contract/governance";

export type RetentionPolicy = OrganizationRetentionPolicyResponse;
export type RetentionPatch = UpdateOrganizationRetentionPolicyRequest;
export type RetentionClass = keyof RetentionPatch;

export const RETENTION_CLASSES = [
  {
    covers: "Threads, inbox threads, workspaces, and stream sessions",
    field: "threads",
    maxDays: 3_650,
    minDays: 1,
  },
  {
    covers: "Thread messages, inbox messages, and drafts",
    field: "messages",
    maxDays: 3_650,
    minDays: 1,
  },
  {
    covers: "Runs, traces, tool calls, approvals, and evaluation runs",
    field: "runs",
    maxDays: 3_650,
    minDays: 1,
  },
  {
    covers: "Artifacts, inbox attachments, and data exports",
    field: "artifacts",
    maxDays: 3_650,
    minDays: 1,
  },
  {
    covers: "Commands, webhook deliveries, and semantic and timeline events",
    field: "events",
    maxDays: 3_650,
    minDays: 1,
  },
  { covers: "Audit events and audit exports", field: "audit", maxDays: 3_650, minDays: 365 },
] as const satisfies readonly {
  readonly covers: string;
  readonly field: RetentionClass;
  readonly maxDays: number;
  readonly minDays: number;
}[];

export type RetentionDraft = Readonly<Record<RetentionClass, string>>;

export interface RetentionIssue {
  readonly field: RetentionClass;
  readonly message: string;
}

export type RetentionPlan =
  | { readonly kind: "invalid"; readonly issues: readonly RetentionIssue[] }
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "change";
      readonly patch: RetentionPatch;
      readonly shortened: readonly RetentionClass[];
    };

export function retentionDraft(policy: RetentionPolicy): RetentionDraft {
  return {
    artifacts: String(policy.artifacts),
    audit: String(policy.audit),
    events: String(policy.events),
    messages: String(policy.messages),
    runs: String(policy.runs),
    threads: String(policy.threads),
  };
}

const days = (raw: string) => (/^\d+$/u.test(raw.trim()) ? Number(raw.trim()) : Number.NaN);

/** Keeps each class the operator edited and moves every class they left alone to `to`. */
export function rebaseRetentionDraft(
  draft: RetentionDraft,
  from: RetentionPolicy,
  to: RetentionPolicy,
): RetentionDraft {
  const pick = (field: RetentionClass) =>
    days(draft[field]) === from[field] ? String(to[field]) : draft[field];
  return {
    artifacts: pick("artifacts"),
    audit: pick("audit"),
    events: pick("events"),
    messages: pick("messages"),
    runs: pick("runs"),
    threads: pick("threads"),
  };
}

export function planRetention(draft: RetentionDraft, current: RetentionPolicy): RetentionPlan {
  const issues: RetentionIssue[] = [];
  const patch: { -readonly [Field in RetentionClass]?: number } = {};
  const shortened: RetentionClass[] = [];
  for (const { field, maxDays, minDays } of RETENTION_CLASSES) {
    const value = days(draft[field]);
    if (!(value >= minDays && value <= maxDays)) {
      issues.push({ field, message: `Enter whole days from ${minDays} to ${maxDays}.` });
    } else if (value !== current[field]) {
      patch[field] = value;
      if (value < current[field]) shortened.push(field);
    }
  }
  if (issues.length > 0) return { issues, kind: "invalid" };
  if (Object.keys(patch).length === 0) return { kind: "unchanged" };
  return { kind: "change", patch, shortened };
}

export function patchApplied(policy: RetentionPolicy, patch: RetentionPatch): boolean {
  return RETENTION_CLASSES.every(({ field }) => (patch[field] ?? policy[field]) === policy[field]);
}
