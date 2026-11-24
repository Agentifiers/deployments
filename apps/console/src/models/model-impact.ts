import {
  admitModel,
  modelPolicyRuleIssues,
  type EffectiveModelPolicy,
  type ModelAdmissionFailureReason,
  type ModelPolicyRules,
} from "@deployments-ai/model-gateway/model-policy";
import type { FetchStatus } from "@tanstack/react-query";
import type { PlatformProblem } from "../errors.ts";

export const MAX_SCAN_RELEASES = 200;

export type ImpactCheck<Preview> =
  | { readonly kind: "checking" }
  | { readonly kind: "failed"; readonly error: Error }
  | { readonly kind: "checked"; readonly preview: Preview };

/** A refetch keeps the earlier scan in `data`; that scan is not the one the dialog asked for. */
export function impactCheck<Preview>(query: {
  readonly data: Preview | undefined;
  readonly error: Error | null;
  readonly fetchStatus: FetchStatus;
}): ImpactCheck<Preview> {
  if (query.fetchStatus !== "idle") return { kind: "checking" };
  if (query.error) return { error: query.error, kind: "failed" };
  return query.data === undefined ? { kind: "checking" } : { kind: "checked", preview: query.data };
}

/** A model the catalog read did not reach is left to the API's own check on save. */
export function policyRuleCheck(
  rules: ModelPolicyRules,
  catalog: { readonly ids: ReadonlySet<string>; readonly complete: boolean },
) {
  const unchecked: string[] = [];
  const issues = modelPolicyRuleIssues(rules, {
    has: (modelId) => {
      if (catalog.ids.has(modelId)) return true;
      if (catalog.complete) return false;
      unchecked.push(modelId);
      return true;
    },
  });
  return { issues, unchecked };
}

export interface ModelFacts {
  readonly synced: ReadonlySet<string>;
  readonly allowedNow: ReadonlyMap<string, boolean>;
}

export type ModelVerdict =
  | { readonly kind: "unchanged_allowed"; readonly basis: "environment-policy" | "operator-grant" }
  | { readonly kind: "newly_denied"; readonly reason: ModelAdmissionFailureReason }
  | { readonly kind: "already_denied"; readonly reason: ModelAdmissionFailureReason }
  | { readonly kind: "newly_allowed" };

export interface ReleaseModels {
  readonly agentDefinitionId: string;
  readonly releaseNumber: number;
  readonly models: { readonly primary: string; readonly fallbacks: readonly string[] };
}

export type ReleaseRead = ReleaseModels | { readonly problem: PlatformProblem };

export interface LiveDeploymentRef {
  readonly id: string;
  readonly desiredState: "paused" | "running" | "stopped";
  readonly agentReleaseId: string;
  readonly candidateAgentReleaseId?: string | undefined;
}

export type ReleaseRole = "primary" | "candidate";

export interface ImpactedRelease {
  readonly releaseId: string;
  readonly agentDefinitionId: string;
  readonly releaseNumber: number;
  readonly deployments: readonly { readonly id: string; readonly role: ReleaseRole }[];
  readonly models: readonly {
    readonly modelId: string;
    readonly slot: "primary" | "fallback";
    readonly verdict: ModelVerdict;
  }[];
}

export interface ModelImpact {
  readonly newlyDenied: readonly ImpactedRelease[];
  readonly alreadyDenied: readonly ImpactedRelease[];
  readonly scan: {
    readonly deployments: number;
    readonly releases: number;
    readonly unread: number;
    readonly skipped: number;
    readonly listsComplete: boolean;
    readonly complete: boolean;
  };
}

export function modelVerdict(
  modelId: string,
  current: EffectiveModelPolicy,
  next: EffectiveModelPolicy,
  facts: ModelFacts,
): ModelVerdict {
  const catalog = { has: (id: string) => facts.synced.has(id) };
  const now = admitModel(modelId, current, catalog);
  const after = admitModel(modelId, next, catalog);
  if (!now.allowed && facts.allowedNow.get(now.modelId) === true) {
    return { basis: "operator-grant", kind: "unchanged_allowed" };
  }
  if (now.allowed) {
    return after.allowed
      ? { basis: "environment-policy", kind: "unchanged_allowed" }
      : { kind: "newly_denied", reason: after.reason };
  }
  return after.allowed ? { kind: "newly_allowed" } : { kind: "already_denied", reason: now.reason };
}

export function modelPolicyImpact(input: {
  readonly deployments: readonly LiveDeploymentRef[];
  readonly listsComplete: boolean;
  /** Every release the scan looked up; a live release missing from it was past the release cap. */
  readonly releases: ReadonlyMap<string, ReleaseRead>;
  readonly facts: ModelFacts;
  readonly current: EffectiveModelPolicy;
  readonly next: EffectiveModelPolicy;
}): ModelImpact {
  const live = input.deployments.filter((deployment) => deployment.desiredState !== "stopped");
  const references = new Map<string, { id: string; role: ReleaseRole }[]>();
  for (const deployment of live) {
    const refs: [string | undefined, ReleaseRole][] = [
      [deployment.agentReleaseId, "primary"],
      [deployment.candidateAgentReleaseId, "candidate"],
    ];
    for (const [releaseId, role] of refs) {
      if (releaseId === undefined) continue;
      const list = references.get(releaseId) ?? [];
      list.push({ id: deployment.id, role });
      references.set(releaseId, list);
    }
  }
  const newlyDenied: ImpactedRelease[] = [];
  const alreadyDenied: ImpactedRelease[] = [];
  let unread = 0;
  let skipped = 0;
  for (const [releaseId, deployments] of references) {
    const release = input.releases.get(releaseId);
    if (release === undefined) {
      skipped += 1;
      continue;
    }
    if ("problem" in release) {
      unread += 1;
      continue;
    }
    const slots = [
      { modelId: release.models.primary, slot: "primary" as const },
      ...release.models.fallbacks.map((modelId) => ({ modelId, slot: "fallback" as const })),
    ];
    const models = slots.map((slot) => ({
      ...slot,
      verdict: modelVerdict(slot.modelId, input.current, input.next, input.facts),
    }));
    const impacted: ImpactedRelease = {
      agentDefinitionId: release.agentDefinitionId,
      deployments,
      models,
      releaseId,
      releaseNumber: release.releaseNumber,
    };
    if (models.some((model) => model.verdict.kind === "newly_denied")) newlyDenied.push(impacted);
    else if (models.some((model) => model.verdict.kind === "already_denied")) {
      alreadyDenied.push(impacted);
    }
  }
  return {
    alreadyDenied: alreadyDenied.toSorted(byRelease),
    newlyDenied: newlyDenied.toSorted(byRelease),
    scan: {
      complete: input.listsComplete && unread === 0 && skipped === 0,
      deployments: live.length,
      listsComplete: input.listsComplete,
      releases: references.size,
      skipped,
      unread,
    },
  };
}

function byRelease(left: ImpactedRelease, right: ImpactedRelease) {
  return (
    left.agentDefinitionId.localeCompare(right.agentDefinitionId) ||
    left.releaseNumber - right.releaseNumber
  );
}

export function impactIsDestructive(impact: ModelImpact) {
  return impact.newlyDenied.length > 0 || !impact.scan.complete;
}
