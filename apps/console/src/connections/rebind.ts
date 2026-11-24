import type { CreateConnectionGrantRequest } from "@deployments-ai/api-contract/providers";
import type { DeploymentConfig, ToolBindingChanges } from "../agents/runtime-config.ts";
import { oneOf } from "../observability/range.ts";
import {
  grantableScopes,
  isLiveDeployment,
  type CapabilityView,
  type ConnectionView,
  type GrantUse,
  type GrantView,
  type PinningDeploymentView,
  type VerificationView,
} from "./connection-state.ts";
import {
  authorizationOrder,
  identityCanCollide,
  OAUTH_CALLBACK_ERRORS,
  parseConnectReturn,
  type AuthorizationOrder,
  type OAuthCallbackError,
} from "./oauth.ts";

export type CreateGrantBody = typeof CreateConnectionGrantRequest.Type;

/** Grants and deployments the operator took out of, or added to, what a rebind restores. */
export interface RebindSelections {
  /** Grants restored by default that the operator chose not to restore. */
  readonly skip?: readonly string[];
  /** Grants revoked earlier, still pinned, that the operator chose to restore. */
  readonly include?: readonly string[];
  /** Deployments the operator chose not to re-pin. */
  readonly skipDeployments?: readonly string[];
}

/**
 * Choices the operator made on the rebind page. A static rotate revokes every active grant of
 * the connection and stamps each with the rotation's timestamp, which the rotate response
 * returns as `updatedAt`. For a rotate, that value is `since`: grants revoked at or after it are
 * restored by default, and grants revoked earlier are restored only when the operator opts them
 * in. A reauthorization restores the old connection's active grants and the grants its own
 * revocation revoked, and uses `since` only to reject a target older than the reauthorization.
 */
interface RebindChoices extends RebindSelections {
  readonly since?: string;
  /** The verification the page last ran, so a reload shows its outcome. */
  readonly verification?: string;
}

/** A rotated static credential: the connection is its own target. */
export interface RotateSearch extends RebindChoices {
  readonly kind: "rotate";
}

/**
 * An OAuth connection replaced by a new authorization, which the provider callback names in
 * `target`, or refused in `error`.
 */
export interface ReauthorizeSearch extends RebindChoices {
  readonly kind: "reauthorize";
  readonly target?: string;
  readonly error?: OAuthCallbackError;
}

/** Where a rebind stands, read from the page URL. */
export type RebindSearch = RotateSearch | ReauthorizeSearch;

/** Server reads the planner needs; the page reads them again before every step. */
export interface RebindObservation {
  readonly old: ConnectionView;
  /** The reauthorized connection, once the callback named it; a rotate's target is `old`. */
  readonly target?: ConnectionView;
  readonly targetCapabilities: readonly CapabilityView[];
  readonly verification?: VerificationView;
  readonly grants: readonly GrantView[];
  readonly deployments: readonly PinningDeploymentView[];
  /** When the console server read the rest. */
  readonly now: string;
}

/** A revoked grant to restore on the target, and the active grant that restores it, if any. */
export interface GrantTemplate {
  readonly grant: GrantView;
  readonly pinnedBy: readonly GrantUse[];
  readonly replacement?: GrantView;
  readonly missingScopes: readonly string[];
  readonly skipped: boolean;
}

/** A grant revoked before the rebind started that a live deployment still pins. */
export interface EarlierRevocation {
  readonly grant: GrantView;
  readonly pinnedBy: readonly GrantUse[];
  readonly included: boolean;
}

export interface VerifyStep {
  readonly kind: "verify";
  readonly connectionId: string;
}

export interface CreateGrantStep {
  readonly kind: "create-grant";
  readonly templateId: string;
  readonly body: CreateGrantBody;
  readonly key: string;
}

/** The server appends the deployment version it read just before the update to `keyPrefix`. */
export interface PinStep {
  readonly kind: "pin";
  readonly deploymentId: string;
  readonly replacements: Readonly<Record<string, string>>;
  readonly keyPrefix: string;
}

export interface RevokeOldStep {
  readonly kind: "revoke-old";
  readonly connectionId: string;
  readonly expectedVersion: number;
  readonly key: string;
}

export type RebindStep = VerifyStep | CreateGrantStep | PinStep | RevokeOldStep;

/** The steps Continue runs; the operator revokes the old connection in a dialog instead. */
export type RunnerStep = Exclude<RebindStep, RevokeOldStep>;

/** Why the last attempt at a step failed for good, as the API answered. */
export interface StepProblem {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;
}

/** The step the runner last tried and the 4xx it got; the page holds it until it plans again. */
export interface StepFailure {
  readonly stepKey: string;
  readonly problem: StepProblem;
}

/**
 * `since` in the authorization phases is the value the provider callback must carry back, so the
 * page after it refuses a target created before the reauthorization began.
 */
export type RebindPhase =
  | {
      readonly kind: "awaiting-authorization";
      readonly order: AuthorizationOrder;
      readonly since: string;
    }
  | {
      readonly kind: "authorization-failed";
      readonly error: OAuthCallbackError | "wrong-provider";
      /** The provider may have refused because the old connection still holds the account. */
      readonly collisionPossible: boolean;
      readonly since: string;
    }
  | { readonly kind: "awaiting-verification"; readonly next: VerifyStep }
  | { readonly kind: "verification-failed"; readonly verification: VerificationView }
  | { readonly kind: "scope-gap"; readonly templates: readonly GrantTemplate[] }
  | { readonly kind: "granting"; readonly remaining: number; readonly next: CreateGrantStep }
  | { readonly kind: "pinning"; readonly remaining: number; readonly next: PinStep }
  | { readonly kind: "revoking-old"; readonly next: RevokeOldStep }
  | { readonly kind: "blocked"; readonly step: RunnerStep; readonly problem: StepProblem }
  | {
      readonly kind: "done";
      readonly restored: number;
      readonly repinned: number;
      readonly skipped: number;
      /**
       * Live deployments that still pin a revoked grant of the connection, so their tools stay
       * denied: skipped, failed, or deploying deployments, and pins of grants left revoked.
       */
      readonly needsOperator: readonly string[];
    };

export interface RebindPlan {
  readonly phase: RebindPhase;
  readonly templates: readonly GrantTemplate[];
  readonly revokedEarlier: readonly EarlierRevocation[];
  readonly repinDeploymentIds: readonly string[];
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

function ids(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && ULID.test(id))
    : [];
}

function selections(search: Readonly<Record<string, unknown>>): RebindSelections {
  const lists = {
    include: ids(search.include),
    skip: ids(search.skip),
    skipDeployments: ids(search.skipDeployments),
  };
  return Object.fromEntries(Object.entries(lists).filter(([, list]) => list.length > 0));
}

export function parseRebindSearch(search: Readonly<Record<string, unknown>>): RebindSearch {
  const { since, target, verification } = search;
  const choices: RebindChoices = {
    ...(typeof since === "string" && Number.isFinite(Date.parse(since))
      ? { since: new Date(since).toISOString() }
      : {}),
    ...(typeof verification === "string" && ULID.test(verification) ? { verification } : {}),
    ...selections(search),
  };
  if (search.kind !== "reauthorize") return { kind: "rotate", ...choices };
  const error = oneOf(OAUTH_CALLBACK_ERRORS, search.error);
  return {
    kind: "reauthorize",
    ...choices,
    ...(typeof target === "string" && ULID.test(target) ? { target } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Where a provider callback that returns to a reauthorization goes next: the old connection's
 * rebind page with the target or error the callback named, and the choices the operator made
 * before leaving for the consent page.
 */
export function reauthorizeReturn(
  search: Readonly<Record<string, unknown>>,
): { readonly oldConnectionId: string; readonly search: ReauthorizeSearch } | undefined {
  const { rebind, result } = parseConnectReturn(search);
  if (!rebind) return undefined;
  return {
    oldConnectionId: rebind.oldConnectionId,
    search: {
      kind: "reauthorize",
      ...(rebind.since ? { since: rebind.since } : {}),
      ...selections(search),
      ...(result.kind === "connected" ? { target: result.connectionId } : {}),
      ...(result.kind === "failed" ? { error: result.error } : {}),
    },
  };
}

/**
 * Revoking the old connection. A reauthorization does it last, once every pin moved, or first
 * (`pending` target) when the provider would refuse a second connection to the same account.
 */
export function revokeOldStep(
  old: Pick<ConnectionView, "id" | "version">,
  targetId: string | undefined,
): RevokeOldStep {
  return {
    connectionId: old.id,
    expectedVersion: old.version,
    key: `rebind:${old.id}:${targetId ?? "pending"}:revoke:${old.version}`,
    kind: "revoke-old",
  };
}

/**
 * The rebind URL after a rotate that returned `rotatedAt`. Rotating again from a rebind keeps
 * the first rotation's `since`, because the grants it revoked still wait to be restored, and
 * drops the verification of the replaced credential.
 */
export function searchAfterRotate(rotatedAt: string, current?: RotateSearch): RotateSearch {
  const { verification: _replaced, ...kept } = current ?? { kind: "rotate" };
  return { ...kept, since: kept.since ?? rotatedAt };
}

/**
 * The rebind URL that skips a blocked step: its grant or deployment, never the verification or
 * the revocation of the old connection.
 */
export function searchSkipping(search: RebindSearch, step: RebindStep): RebindSearch | undefined {
  switch (step.kind) {
    case "verify":
    case "revoke-old":
      return undefined;
    case "create-grant":
      return { ...search, skip: [...(search.skip ?? []), step.templateId] };
    case "pin":
      return {
        ...search,
        skipDeployments: [...(search.skipDeployments ?? []), step.deploymentId],
      };
    default: {
      const unexpected: never = step;
      return unexpected;
    }
  }
}

/**
 * Whether a re-pin may update the deployment. An update sets `currentState` to ready or paused,
 * so a failed or deploying deployment is left to the operator instead.
 */
export function isRepinnable<
  Deployment extends Pick<PinningDeploymentView, "currentState" | "desiredState">,
>(
  deployment: Deployment,
): deployment is Deployment & {
  readonly desiredState: Exclude<Deployment["desiredState"], "stopped">;
} {
  return (
    isLiveDeployment(deployment) &&
    (deployment.currentState === "ready" || deployment.currentState === "paused")
  );
}

export function stepKey(step: RebindStep): string {
  switch (step.kind) {
    case "verify":
      return "verify";
    case "create-grant":
    case "revoke-old":
      return step.key;
    case "pin":
      return step.keyPrefix;
    default: {
      const unexpected: never = step;
      return unexpected;
    }
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

/** Grants with equal fingerprints authorize the same thing in the same workspace. */
export function grantFingerprint(grant: GrantView): string {
  return JSON.stringify([
    grant.workspaceId,
    grant.purpose,
    grant.scopes.toSorted(),
    canonical(grant.externalResourceConstraints),
  ]);
}

/**
 * The tool binding changes that swap every pinned grant in `replacements` for its replacement,
 * keeping each binding's tool policy. Empty when no pin changes.
 */
export function repinChanges(
  config: DeploymentConfig | undefined,
  replacements: Readonly<Record<string, string>>,
): ToolBindingChanges {
  return Object.fromEntries(
    Object.entries(config?.toolAuthorizations ?? {}).flatMap(([tool, binding]) => {
      const replacement = replacements[binding.authorizationId];
      return replacement === undefined
        ? []
        : [[tool, { ...binding, authorizationId: replacement }]];
    }),
  );
}

function pinsByGrant(deployments: readonly PinningDeploymentView[]) {
  const pins = new Map<string, GrantUse[]>();
  for (const deployment of deployments) {
    for (const [toolName, binding] of Object.entries(
      deployment.runtimeConfig?.toolAuthorizations ?? {},
    )) {
      const use = { deploymentId: deployment.id, toolName };
      const uses = pins.get(binding.authorizationId);
      if (uses) uses.push(use);
      else pins.set(binding.authorizationId, [use]);
    }
  }
  return pins;
}

function pinsAny(deployment: PinningDeploymentView, grantIds: ReadonlySet<string>) {
  return Object.values(deployment.runtimeConfig?.toolAuthorizations ?? {}).some((binding) =>
    grantIds.has(binding.authorizationId),
  );
}

const byCreatedAt = (left: GrantView, right: GrantView) =>
  left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

/**
 * The grant that restores `template` on the target. The key ends with the number of revoked
 * grants on the target that share the template's fingerprint and were created after it. An
 * earlier attempt's replacement is one of them once it is revoked, and only then does the plan
 * create another, so no restore reuses a key an earlier one spent.
 */
function createGrantStep(
  observation: RebindObservation,
  target: ConnectionView,
  template: GrantTemplate,
): CreateGrantStep {
  const { grant } = template;
  const fingerprint = grantFingerprint(grant);
  const attempts = observation.grants.filter(
    (other) =>
      other.connectionId === target.id &&
      other.status === "revoked" &&
      byCreatedAt(other, grant) > 0 &&
      grantFingerprint(other) === fingerprint,
  ).length;
  const constraints = grant.externalResourceConstraints;
  return {
    body: {
      connectionId: target.id,
      purpose: grant.purpose,
      scopes: grant.scopes,
      workspaceId: grant.workspaceId,
      ...(Object.keys(constraints).length > 0 ? { externalResourceConstraints: constraints } : {}),
    },
    key: `rebind:${observation.old.id}:${target.id}:grant:${grant.id}:${attempts}`,
    kind: "create-grant",
    templateId: grant.id,
  };
}

/** The connection grants move to, or the phase that waits for a usable one. */
type TargetResolution = { readonly target: ConnectionView } | { readonly phase: RebindPhase };

/**
 * A reauthorization's target is the connection the provider callback named, if it is a newer
 * connection to the same provider. The reauthorization began at the URL's `since` when that lies
 * between the old connection's creation and now, and otherwise at the old connection's last
 * change: the revocation, for a connection already revoked. A named target the API does not
 * know reads as missing, and is refused like a target for another provider.
 */
function resolveTarget(
  observation: RebindObservation,
  search: ReauthorizeSearch,
): TargetResolution {
  const { now, old, target } = observation;
  const since =
    search.since !== undefined && search.since >= old.createdAt && search.since <= now
      ? search.since
      : old.updatedAt;
  if (target === undefined && search.target === undefined) {
    return {
      phase: search.error
        ? {
            collisionPossible:
              search.error === "authorization_failed" &&
              identityCanCollide(old) &&
              old.status !== "disconnected",
            error: search.error,
            kind: "authorization-failed",
            since,
          }
        : { kind: "awaiting-authorization", order: authorizationOrder(old, now), since },
    };
  }
  if (
    target !== undefined &&
    target.id !== old.id &&
    target.providerKey === old.providerKey &&
    target.createdAt >= since
  ) {
    return { target };
  }
  return {
    phase: {
      collisionPossible: false,
      error: "wrong-provider",
      kind: "authorization-failed",
      since,
    },
  };
}

/**
 * The next step of a rebind, derived only from server reads, the URL, and the last failed step,
 * so any page load by any owner or admin resumes it. A reauthorization first waits for the
 * callback to name its target. The plan then verifies the target, gives each restored grant's
 * fingerprint one active grant on the target, re-pins every repinnable deployment from the old
 * grants to their replacements, and finally revokes a reauthorized connection.
 */
export function planRebind(
  observation: RebindObservation,
  search: RebindSearch,
  failure?: StepFailure,
): RebindPlan {
  const { old } = observation;
  const resolution: TargetResolution =
    search.kind === "rotate" ? { target: old } : resolveTarget(observation, search);
  const target = "target" in resolution ? resolution.target : undefined;
  const live = observation.deployments.filter(isLiveDeployment);
  const pins = pinsByGrant(live);
  const revoked = observation.grants.filter(
    (grant) => grant.connectionId === old.id && grant.status === "revoked",
  );
  // A rotation stamps the grants it revokes with `since`, and revoking the old connection stamps
  // its grants with the revocation; anything revoked otherwise was an operator's choice.
  const revokedByRebind = (grant: GrantView) =>
    search.kind === "rotate"
      ? search.since !== undefined && grant.updatedAt >= search.since
      : old.status === "disconnected" && grant.updatedAt >= old.updatedAt;
  const included = new Set(search.include);
  const revokedEarlier = revoked
    .filter((grant) => !revokedByRebind(grant) && pins.has(grant.id))
    .toSorted(byCreatedAt)
    .map((grant) => ({
      grant,
      included: included.has(grant.id),
      pinnedBy: pins.get(grant.id) ?? [],
    }));
  const stillActive =
    search.kind === "reauthorize"
      ? observation.grants.filter(
          (grant) => grant.connectionId === old.id && grant.status === "active",
        )
      : [];
  const candidates = [
    ...stillActive,
    ...revoked.filter(revokedByRebind),
    ...revokedEarlier.filter((earlier) => earlier.included).map((earlier) => earlier.grant),
  ].toSorted(byCreatedAt);
  const candidateIds = new Set(candidates.map((grant) => grant.id));
  const pool = new Map<string, GrantView>();
  for (const grant of observation.grants.toSorted(byCreatedAt)) {
    const fingerprint = grantFingerprint(grant);
    const reusable =
      grant.connectionId === target?.id && grant.status === "active" && !candidateIds.has(grant.id);
    if (reusable && !pool.has(fingerprint)) pool.set(fingerprint, grant);
  }
  const verification =
    target && observation.verification?.connectionId === target.id
      ? observation.verification
      : undefined;
  const scopes =
    target &&
    (grantableScopes(target, observation.targetCapabilities) ??
      (verification?.status === "verified" && target.status === "active"
        ? target.scopes
        : undefined));
  const skipped = new Set(search.skip);
  const templates = candidates.map((grant): GrantTemplate => {
    const replacement = pool.get(grantFingerprint(grant));
    return {
      grant,
      missingScopes: grant.scopes.filter(
        (scope) => scopes !== undefined && !scopes.includes(scope),
      ),
      pinnedBy: pins.get(grant.id) ?? [],
      skipped: skipped.has(grant.id),
      ...(replacement ? { replacement } : {}),
    };
  });
  const restoring = templates.filter((template) => !template.skipped);
  const revokedIds = new Set(revoked.map((grant) => grant.id));
  const paired = restoring.flatMap((template) =>
    template.replacement ? [[template.grant.id, template.replacement.id] as const] : [],
  );
  const pairedIds = new Set(paired.map(([templateId]) => templateId));
  const skippedDeployments = new Set(search.skipDeployments);
  const repin = live.filter(
    (deployment) =>
      isRepinnable(deployment) &&
      !skippedDeployments.has(deployment.id) &&
      pinsAny(deployment, pairedIds),
  );
  const plan = {
    repinDeploymentIds: repin.map((deployment) => deployment.id),
    revokedEarlier,
    templates,
  };
  const attempt = (next: RunnerStep, phase: RebindPhase): RebindPlan => ({
    ...plan,
    phase:
      failure?.stepKey === stepKey(next)
        ? { kind: "blocked", problem: failure.problem, step: next }
        : phase,
  });

  if ("phase" in resolution) return { ...plan, phase: resolution.phase };
  const to = resolution.target;
  if (scopes === undefined) {
    if (verification?.status === "failed") {
      return { ...plan, phase: { kind: "verification-failed", verification } };
    }
    const next: VerifyStep = { connectionId: to.id, kind: "verify" };
    return attempt(next, { kind: "awaiting-verification", next });
  }
  const pending = new Map<string, GrantTemplate>();
  for (const template of restoring) {
    const fingerprint = grantFingerprint(template.grant);
    if (!template.replacement && !pending.has(fingerprint)) pending.set(fingerprint, template);
  }
  const gap = [...pending.values()].filter((template) => template.missingScopes.length > 0);
  if (gap.length > 0) return { ...plan, phase: { kind: "scope-gap", templates: gap } };
  const [nextGrant] = pending.values();
  if (nextGrant) {
    const next = createGrantStep(observation, to, nextGrant);
    return attempt(next, { kind: "granting", next, remaining: pending.size });
  }
  const [nextPin] = repin;
  if (nextPin) {
    const next: PinStep = {
      deploymentId: nextPin.id,
      keyPrefix: `rebind:${old.id}:${to.id}:pin:${nextPin.id}`,
      kind: "pin",
      replacements: Object.fromEntries(paired),
    };
    return attempt(next, { kind: "pinning", next, remaining: repin.length });
  }
  if (search.kind === "reauthorize" && old.status !== "disconnected") {
    return { ...plan, phase: { kind: "revoking-old", next: revokeOldStep(old, to.id) } };
  }
  const replacementIds = new Set(paired.map(([, replacementId]) => replacementId));
  return {
    ...plan,
    phase: {
      kind: "done",
      needsOperator: live
        .filter((deployment) => pinsAny(deployment, revokedIds))
        .map((deployment) => deployment.id),
      repinned: live.filter((deployment) => pinsAny(deployment, replacementIds)).length,
      restored: paired.length,
      skipped: templates.length - restoring.length,
    },
  };
}
