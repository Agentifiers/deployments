import { haltMode, type HoldReason, type HoldState, type StandingHold } from "@deployments-ai/db";

/** Everything an organization can do that standing may refuse. */
export type OrganizationActivity =
  /** GET or HEAD on a public API route, or a mutation its contract declares `standing: "read"`. */
  | "api.read"
  /** A mutation whose route contract declares no standing. */
  | "api.write"
  /** A mutation its contract declares `standing: "remediation"`: it reduces access or activity. */
  | "api.remediate"
  /** A mutation its contract declares `standing: "erasure"`: it destroys customer data. */
  | "api.erase"
  /**
   * A mutation its contract declares `standing: "distribution"`: it mints a link that serves
   * customer data to whoever holds it.
   */
  | "api.distribute"
  /** An install-wide `System` route: operators and services acting on organizations, not as them. */
  | "api.operate"
  /** Create a run: submit a turn, start an evaluation, retry, or resume. */
  | "run.admit"
  /** Keep an admitted run going: claim, heartbeat, its model tokens, and its in-run tools. */
  | "run.continue"
  /**
   * Mint a model gateway token for an organization-context service. A run's token is
   * `run.continue`: it lives and dies with the run.
   */
  | "model.mint"
  /** Serve an agent-built app to visitors and members. */
  | "public.serve"
  /** Accept a channel webhook or inbound email. */
  | "ingress.accept"
  /** Deliver an outbound webhook or agent email. */
  | "outbound.deliver"
  /** Workflow tool steps, Brain sync, memory indexing, document extraction, governance jobs. */
  | "background.process"
  /** Lease a new sandbox. */
  | "sandbox.lease";

export type ApiActivity = Extract<OrganizationActivity, `api.${string}`>;

const PRESERVES_EVIDENCE = {
  abuse: true,
  manual: false,
  payment: false,
  policy: false,
} as const satisfies Record<HoldReason, boolean>;

export type SuspendedHolds = readonly [StandingHold, ...StandingHold[]];

type Verdict = "allow" | "refuse";
type SuspendedRule = Verdict | ((holds: SuspendedHolds) => Verdict);

/** What a suspended organization may still do. An activity without a rule fails to compile. */
export const WHILE_SUSPENDED = {
  "api.read": "allow",
  "api.write": "refuse",
  "api.remediate": "allow",
  "api.erase": (holds) =>
    holds.some((hold) => PRESERVES_EVIDENCE[hold.reason]) ? "refuse" : "allow",
  "api.operate": "allow",
  "api.distribute": (holds) => (haltMode(holds) === "drain" ? "allow" : "refuse"),
  "run.admit": "refuse",
  "run.continue": (holds) => (haltMode(holds) === "drain" ? "allow" : "refuse"),
  "model.mint": "refuse",
  "public.serve": "refuse",
  "ingress.accept": "refuse",
  "outbound.deliver": "refuse",
  "background.process": "refuse",
  "sandbox.lease": "refuse",
} as const satisfies Record<OrganizationActivity, SuspendedRule>;

export type StandingDecision =
  | { readonly kind: "admitted" }
  | { readonly kind: "suspended"; readonly holds: SuspendedHolds };

export function decideActivity(
  standing: HoldState,
  activity: OrganizationActivity,
): StandingDecision {
  if (standing.state === "active") return { kind: "admitted" };
  const rule: SuspendedRule = WHILE_SUSPENDED[activity];
  const verdict = typeof rule === "function" ? rule(standing.holds) : rule;
  return verdict === "allow" ? { kind: "admitted" } : { holds: standing.holds, kind: "suspended" };
}
