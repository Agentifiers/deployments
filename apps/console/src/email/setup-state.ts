import type { RouteResponse } from "../server/platform-api.ts";

export type AgentEmailDomain = RouteResponse<"getAgentEmailDomain">;
export type DomainStatus = AgentEmailDomain["status"];
export type AgentEmailPlacement = RouteResponse<"getAgentEmailPlacement">;
export type AgentEmailPolicy = RouteResponse<"getAgentEmailPolicy">;
export type WarmupStage = AgentEmailPolicy["warmupStage"];

export type PolicyState =
  | { readonly kind: "saved"; readonly policy: AgentEmailPolicy }
  | { readonly kind: "defaults" };

export const DOMAIN_STEPS: Readonly<
  Record<
    DomainStatus,
    { readonly next: string; readonly refreshable: boolean; readonly title: string }
  >
> = {
  failed: {
    next: "Verification failed. Correct the records named in the failure, then refresh.",
    refreshable: true,
    title: "Next step",
  },
  pending: {
    next: "Publish the ownership TXT record, then refresh. The first refresh creates the sending identity and lists the remaining records.",
    refreshable: true,
    title: "Next step",
  },
  pending_dns: {
    next: "Publish every record below at your DNS provider, then refresh to check them.",
    refreshable: true,
    title: "Next step",
  },
  provisioning: {
    next: "The platform is creating the sending identity. Refresh to check again.",
    refreshable: true,
    title: "Next step",
  },
  revoked: {
    next: "Nothing sends from this domain anymore.",
    refreshable: false,
    title: "Revoked",
  },
  verified: {
    next: "Addresses on this domain can send. Refresh rechecks the published records.",
    refreshable: true,
    title: "Verified",
  },
};

/** The SES provisioner refuses to revoke the OpenTofu-managed hosted domain, so only custom domains offer it. */
export function canRevokeDomain(domain: Pick<AgentEmailDomain, "providerManaged" | "status">) {
  return !domain.providerManaged && domain.status !== "revoked";
}

export const WARMUP_STAGES = [
  "sandbox",
  "ramp_1",
  "ramp_2",
  "ramp_3",
  "production",
] as const satisfies readonly WarmupStage[];

export const VERIFIED_RECIPIENTS_ONLY: Readonly<Record<WarmupStage, boolean>> = {
  production: false,
  ramp_1: true,
  ramp_2: false,
  ramp_3: false,
  sandbox: true,
};

export type ReadinessCheck =
  | {
      readonly step: "domain";
      readonly ok: boolean;
      readonly total: number;
      readonly verified: number;
    }
  | {
      readonly step: "placement";
      readonly ok: boolean;
      readonly activeDefaults: number;
      readonly defaults: number;
    }
  | { readonly step: "policy"; readonly ok: boolean; readonly policy: PolicyState };

/** An environment without a saved policy sends under the platform defaults, which are active. */
export function sendingReadiness({
  domains,
  placements,
  policy,
}: {
  readonly domains: readonly Pick<AgentEmailDomain, "status">[];
  readonly placements: readonly Pick<AgentEmailPlacement, "isDefault" | "status">[];
  readonly policy: PolicyState;
}): readonly [
  Extract<ReadinessCheck, { step: "domain" }>,
  Extract<ReadinessCheck, { step: "placement" }>,
  Extract<ReadinessCheck, { step: "policy" }>,
] {
  const verified = domains.filter((domain) => domain.status === "verified").length;
  const defaults = placements.filter((placement) => placement.isDefault);
  const activeDefaults = defaults.filter((placement) => placement.status === "active").length;
  return [
    { ok: verified > 0, step: "domain", total: domains.length, verified },
    {
      activeDefaults,
      defaults: defaults.length,
      ok: defaults.length === 1 && activeDefaults === 1,
      step: "placement",
    },
    {
      ok: policy.kind === "defaults" || policy.policy.sendingStatus === "active",
      policy,
      step: "policy",
    },
  ];
}

const REGION = /^(?:[a-z0-9]+-)+[a-z0-9]+-\d+$/u;

export interface PlacementDraft {
  readonly isDefault: boolean;
  readonly name: string;
  readonly region: string;
  readonly secondaryRegion: string;
}

export interface PlacementBody {
  readonly isDefault: boolean;
  readonly name: string;
  readonly region: string;
  readonly secondaryRegion?: string;
}

export function readPlacementDraft(
  draft: PlacementDraft,
):
  | { readonly ok: true; readonly body: PlacementBody }
  | { readonly ok: false; readonly message: string } {
  const name = draft.name.trim();
  const region = draft.region.trim();
  const secondaryRegion = draft.secondaryRegion.trim();
  if (name === "" || name.length > 120) {
    return { message: "Name the placement in 1 to 120 characters.", ok: false };
  }
  if (!REGION.test(region))
    return { message: "Enter an AWS region, such as us-east-2.", ok: false };
  if (secondaryRegion !== "" && !REGION.test(secondaryRegion)) {
    return { message: "The secondary region must be an AWS region.", ok: false };
  }
  if (secondaryRegion === region) {
    return { message: "The secondary region must differ from the region.", ok: false };
  }
  if (draft.isDefault && secondaryRegion !== "") {
    return { message: "A default placement cannot have a secondary region.", ok: false };
  }
  return {
    body: {
      isDefault: draft.isDefault,
      name,
      region,
      ...(secondaryRegion === "" ? {} : { secondaryRegion }),
    },
    ok: true,
  };
}
