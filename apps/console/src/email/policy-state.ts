import { oneOf } from "../observability/range.ts";
import { parseAddresses } from "./addresses.ts";
import {
  WARMUP_STAGES,
  type AgentEmailPolicy,
  type PolicyState,
  type WarmupStage,
} from "./setup-state.ts";

export const POLICY_LIMITS = {
  bounceRateThresholdBasisPoints: { label: "Bounce rate threshold", max: 10_000, min: 0 },
  complaintRateThresholdBasisPoints: { label: "Complaint rate threshold", max: 10_000, min: 0 },
  dailyOutboundMessageLimit: {
    label: "Daily outbound limit",
    max: Number.MAX_SAFE_INTEGER,
    min: 0,
  },
  maxAttachmentBytes: { label: "Attachment limit", max: 4 * 1024 * 1024, min: 0 },
  maxRecipientsPerMessage: { label: "Recipients per message", max: 47, min: 1 },
  rawRetentionDays: { label: "Raw message retention", max: 365, min: 1 },
} as const;

export type PolicyNumber = keyof typeof POLICY_LIMITS;
export const POLICY_NUMBERS = [
  "dailyOutboundMessageLimit",
  "maxRecipientsPerMessage",
  "maxAttachmentBytes",
  "rawRetentionDays",
  "bounceRateThresholdBasisPoints",
  "complaintRateThresholdBasisPoints",
] as const satisfies readonly PolicyNumber[];

const MAX_LISTED_ADDRESSES = 50;

export type PolicyDraft = Readonly<Record<PolicyNumber, string>> & {
  readonly allowlist: string;
  readonly blocklist: string;
  readonly warmupStage: WarmupStage | "";
};

export type PolicyChanges = Partial<
  Pick<AgentEmailPolicy, PolicyNumber | "warmupStage"> & {
    readonly allowlist: readonly string[];
    readonly blocklist: readonly string[];
  }
>;

export type PolicyEdit =
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "unchanged" }
  | { readonly kind: "changes"; readonly body: PolicyChanges };

export function policyDraft(state: PolicyState): PolicyDraft {
  if (state.kind === "defaults") {
    return {
      allowlist: "",
      blocklist: "",
      bounceRateThresholdBasisPoints: "",
      complaintRateThresholdBasisPoints: "",
      dailyOutboundMessageLimit: "",
      maxAttachmentBytes: "",
      maxRecipientsPerMessage: "",
      rawRetentionDays: "",
      warmupStage: "",
    };
  }
  const { policy } = state;
  return {
    allowlist: (policy.allowlist ?? []).join("\n"),
    blocklist: (policy.blocklist ?? []).join("\n"),
    bounceRateThresholdBasisPoints: String(policy.bounceRateThresholdBasisPoints),
    complaintRateThresholdBasisPoints: String(policy.complaintRateThresholdBasisPoints),
    dailyOutboundMessageLimit: String(policy.dailyOutboundMessageLimit),
    maxAttachmentBytes: String(policy.maxAttachmentBytes),
    maxRecipientsPerMessage: String(policy.maxRecipientsPerMessage),
    rawRetentionDays: String(policy.rawRetentionDays),
    warmupStage: policy.warmupStage,
  };
}

const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((entry) => right.includes(entry));

export function policyChanges(draft: PolicyDraft, state: PolicyState): PolicyEdit {
  const saved = state.kind === "saved" ? state.policy : undefined;
  const body: { -readonly [Field in keyof PolicyChanges]: PolicyChanges[Field] } = {};
  for (const field of POLICY_NUMBERS) {
    const text = draft[field].trim();
    if (text === "") continue;
    const { label, max, min } = POLICY_LIMITS[field];
    const value = Number(text);
    if (!/^\d+$/u.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
      return { kind: "invalid", message: `${label} must be a whole number from ${min} to ${max}.` };
    }
    if (saved?.[field] !== value) body[field] = value;
  }
  const warmupStage = oneOf(WARMUP_STAGES, draft.warmupStage);
  if (warmupStage !== undefined && saved?.warmupStage !== warmupStage) {
    body.warmupStage = warmupStage;
  }
  for (const field of ["allowlist", "blocklist"] as const) {
    const parsed = parseAddresses(draft[field], MAX_LISTED_ADDRESSES);
    if (!parsed.ok) return { kind: "invalid", message: parsed.message };
    if (!sameList(parsed.addresses, saved?.[field] ?? [])) body[field] = parsed.addresses;
  }
  return Object.keys(body).length === 0 ? { kind: "unchanged" } : { body, kind: "changes" };
}
