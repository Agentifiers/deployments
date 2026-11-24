import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  connectionActions,
  verificationOutcome,
  type PinningDeploymentView,
  type VerificationView,
} from "../../connections/connection-state.ts";
import {
  planRebind,
  searchSkipping,
  stepKey,
  type RebindObservation,
  type RebindPhase,
  type RebindSearch,
  type RunnerStep,
} from "../../connections/rebind.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import {
  createGrantFn,
  pinDeploymentFn,
  verifyConnectionFn,
} from "../../data/connection-mutations.ts";
import {
  invalidateConnections,
  rebindObservationQuery,
  rereadOnConflict,
  workspacesQuery,
} from "../../data/connection-queries.ts";
import { PlatformApiError, UnauthenticatedError } from "../../errors.ts";
import { formatExact } from "../../observability/format.ts";
import { environmentPath, scopeKey, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Subheading } from "@/components/ui/heading";
import { Text, TextLink } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { describeProblem, ProblemReference } from "../section-boundary.tsx";
import { RotateCredentialDialog } from "./credential-dialogs.tsx";
import {
  ReauthorizeControls,
  ReauthorizePhaseDetail,
  ReauthorizeTarget,
} from "./reauthorize-controls.tsx";
import { EarlierTable, TemplateTable } from "./rebind-tables.tsx";

/** Bounds one Continue: every grant and pin plus the replays a lagging list causes. */
const MAX_STEPS = 60;
/** A list that has not caught up with the previous step's write plans that step again. */
const REPEAT_WAIT_MS = 1_000;
const MAX_REPEATS = 5;

function count(value: number, one: string, many: string) {
  return `${formatExact(value)} ${value === 1 ? one : many}`;
}

/**
 * A step the API refused. The page plans it as blocked until the operator skips or retries it,
 * or until the connection changes, as a second rotation does.
 */
interface Refusal {
  readonly connectionVersion: number;
  readonly error: PlatformApiError;
  readonly stepKey: string;
}

/**
 * Whether the API refused the step for good. A 5xx, a throttle, or a request still in flight may
 * succeed on the next Continue with the same key, and a pin's version conflict only means the
 * deployment changed, so the next plan reads it again.
 */
function refused(error: unknown, step: RunnerStep): error is PlatformApiError {
  if (!(error instanceof PlatformApiError)) return false;
  const { code, status } = error.problem;
  if (status >= 500 || status === 429 || code === "idempotency_in_progress") return false;
  return !(step.kind === "pin" && code === "version_conflict");
}

async function runStep(step: RunnerStep, scope: EnvironmentScope) {
  switch (step.kind) {
    case "verify":
      return verifyConnectionFn({
        data: { connectionId: step.connectionId, idempotencyKey: crypto.randomUUID(), scope },
      });
    case "create-grant":
      await createGrantFn({ data: { body: step.body, idempotencyKey: step.key, scope } });
      return undefined;
    case "pin":
      await pinDeploymentFn({
        data: {
          deploymentId: step.deploymentId,
          keyPrefix: step.keyPrefix,
          replacements: step.replacements,
          scope,
        },
      });
      return undefined;
    default: {
      const unexpected: never = step;
      throw new TypeError(`Unknown rebind step ${JSON.stringify(unexpected)}.`);
    }
  }
}

/**
 * Runs rebind steps until the plan has none left, the API refuses one, or only the revocation of
 * the old connection is left, which the operator confirms. Each iteration reads the server state
 * again and plans from it, so a crash, a reload, or another admin's progress changes nothing but
 * which step comes next.
 */
async function continueRebind({
  connectionId,
  onSearch,
  queryClient,
  scope,
  search,
}: {
  readonly connectionId: string;
  readonly onSearch: (search: RebindSearch) => void;
  readonly queryClient: QueryClient;
  readonly scope: EnvironmentScope;
  readonly search: RebindSearch;
}): Promise<Refusal | undefined> {
  let current = search;
  let previous: string | undefined;
  let repeats = 0;
  for (let attempt = 0; attempt < MAX_STEPS; attempt += 1) {
    const observation = await queryClient.fetchQuery(
      rebindObservationQuery(scope, connectionId, current),
    );
    const { phase } = planRebind(observation, current);
    if (!("next" in phase)) return undefined;
    const { next } = phase;
    if (next.kind === "revoke-old") return undefined;
    const key = stepKey(next);
    repeats = next.kind !== "verify" && key === previous ? repeats + 1 : 0;
    if (repeats > MAX_REPEATS) {
      throw new Error(
        "The platform has not caught up with the last change yet. Continue again in a moment.",
      );
    }
    if (repeats > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, REPEAT_WAIT_MS);
      await promise;
    }
    previous = key;
    let verification: VerificationView | undefined;
    try {
      verification = await runStep(next, scope);
    } catch (error) {
      if (refused(error, next)) {
        return { connectionVersion: observation.old.version, error, stepKey: key };
      }
      if (error instanceof PlatformApiError && error.problem.code === "version_conflict") continue;
      throw error;
    }
    if (verification) {
      current = { ...current, verification: verification.id };
      // The panel must not suspend on the new URL while this runs: a suspended panel drops its
      // mutation observer, and the runner would show "Working…" forever.
      await queryClient.fetchQuery(rebindObservationQuery(scope, connectionId, current));
      onSearch(current);
      if (verification.status !== "verified") return undefined;
    }
  }
  throw new Error("The rebind did not finish in one go. Continue again to resume it.");
}

const PHASE_COPY: Readonly<
  Record<RebindPhase["kind"], { readonly title: string; readonly destructive?: boolean }>
> = {
  "awaiting-authorization": { title: "Authorize the new connection" },
  "authorization-failed": { destructive: true, title: "The authorization did not finish" },
  "awaiting-verification": { title: "Verify the new credential" },
  "verification-failed": { destructive: true, title: "Verification failed" },
  "scope-gap": {
    destructive: true,
    title: "Some grants ask for scopes the connection no longer holds",
  },
  granting: { title: "Restoring grants" },
  pinning: { title: "Re-pinning deployments" },
  "revoking-old": { title: "Revoke the old connection" },
  blocked: { destructive: true, title: "The platform refused a step" },
  done: { title: "Grants and pins restored" },
};

const BLOCKED_STEP_COPY: Readonly<Record<RunnerStep["kind"], string>> = {
  "create-grant": "Restoring a grant failed. Skip it to restore the rest, or fix it and continue.",
  pin: "Re-pinning a deployment failed. Skip it to re-pin the rest, or fix it and continue.",
  verify: "The credential could not be verified. Rotate it again, or fix it and continue.",
};

function PhaseDetail({
  observation,
  phase,
  search,
}: Readonly<{
  observation: RebindObservation;
  phase: RebindPhase;
  search: RebindSearch;
}>): ReactNode {
  switch (phase.kind) {
    case "awaiting-authorization":
    case "authorization-failed":
    case "revoking-old":
      return <ReauthorizePhaseDetail observation={observation} phase={phase} />;
    case "awaiting-verification":
      return "Continue checks the credential with the provider. Grants are restored only after it passes.";
    case "verification-failed": {
      const { problem } = verificationOutcome(phase.verification);
      return (
        <>
          {problem ? <p>{problem}</p> : null}
          <p>
            {search.kind === "reauthorize"
              ? `Verify again. If it keeps failing, revoke ${observation.target?.displayName ?? "the new connection"} and reauthorize again from the page of ${observation.old.displayName}.`
              : observation.old.authMethod === "oauth"
                ? "Verify again. If it keeps failing, reauthorize the connection from its page."
                : "Rotate the credential again with correct values, or verify again."}
          </p>
        </>
      );
    }
    case "scope-gap":
      return `${count(phase.templates.length, "grant needs", "grants need")} scopes the verified credential does not hold. Skip them to restore the rest.`;
    case "granting":
      return `${count(phase.remaining, "grant", "grants")} left to restore.`;
    case "pinning":
      return `${count(phase.remaining, "deployment", "deployments")} left to re-pin.`;
    case "blocked":
      return BLOCKED_STEP_COPY[phase.step.kind];
    case "done":
      return `Restored ${count(phase.restored, "grant", "grants")}, re-pinned ${count(phase.repinned, "deployment", "deployments")}, skipped ${count(phase.skipped, "grant", "grants")}.`;
    default: {
      const unexpected: never = phase;
      return unexpected;
    }
  }
}

function NeedsOperator({
  deploymentIds,
  deployments,
  scope,
}: Readonly<{
  deploymentIds: readonly string[];
  deployments: readonly PinningDeploymentView[];
  scope: EnvironmentScope;
}>) {
  const definitions = new Map<string, string>(
    deployments.map((deployment) => [deployment.id, deployment.agentDefinitionId]),
  );
  return (
    <Callout variant="destructive">
      <CalloutTitle>
        {count(deploymentIds.length, "deployment still pins", "deployments still pin")} a revoked
        grant
      </CalloutTitle>
      <CalloutDescription>
        <p>
          Their tools stay denied. Restore the grants they need and continue, or point their tool
          authorizations at active grants yourself. The console does not update skipped deployments,
          or deployments that are failed or still deploying, because updating one marks it ready.
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          {deploymentIds.map((id) => {
            const definitionId = definitions.get(id);
            return (
              <li className="flex items-center gap-2" key={id}>
                <PublicId value={id} />
                {definitionId ? (
                  <TextLink href={`${environmentPath(scope)}/agents/${definitionId}/tools`}>
                    Tools
                  </TextLink>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CalloutDescription>
    </Callout>
  );
}

function toggled(list: readonly string[] | undefined, id: string) {
  const current = list ?? [];
  return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
}

export function RebindPanel({
  connectionId,
  onSearch,
  scope,
  search,
}: Readonly<{
  connectionId: string;
  onSearch: (search: RebindSearch) => void;
  scope: EnvironmentScope;
  search: RebindSearch;
}>) {
  const queryClient = useQueryClient();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { access } = shell;
  const observationQuery = rebindObservationQuery(scope, connectionId, search);
  const { data: observation } = useSuspenseQuery(observationQuery);
  const workspaces = useQuery({ ...workspacesQuery(scope), enabled: access.listWorkspaces });
  const [refusal, setRefusal] = useState<Refusal>();
  const [rotating, setRotating] = useState(false);
  const [confirmedTarget, setConfirmedTarget] = useState<string>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const blockedBy = refusal?.connectionVersion === observation.old.version ? refusal : undefined;
  const plan = planRebind(
    observation,
    search,
    blockedBy ? { problem: blockedBy.error.problem, stepKey: blockedBy.stepKey } : undefined,
  );
  const { phase } = plan;
  const canFinish =
    access.requestConnectionVerification &&
    access.createConnectionGrant &&
    access.getAgentDeployment &&
    access.updateAgentDeployment;
  const runner = useMutation({
    mutationFn: (from: RebindSearch) =>
      continueRebind({
        connectionId,
        // A Continue outlives the page; once the operator has left, its URL update would pull
        // them back.
        onSearch: (next) => {
          if (mounted.current) onSearch(next);
        },
        queryClient,
        scope,
        search: from,
      }),
    onMutate: () => setRefusal(undefined),
    onSuccess: (result) => setRefusal(result),
    onSettled: () =>
      Promise.all([
        invalidateConnections(queryClient, scope),
        queryClient.invalidateQueries({ queryKey: ["agents", ...scopeKey(scope)] }),
        queryClient.invalidateQueries({ queryKey: ["agent", ...scopeKey(scope)] }),
      ]),
  });
  if (runner.error instanceof UnauthenticatedError) throw runner.error;
  const problem = runner.error
    ? describeProblem(runner.error, "The rebind stopped")
    : blockedBy
      ? describeProblem(blockedBy.error, "The platform refused the step")
      : undefined;
  const copy =
    phase.kind === "done" && phase.needsOperator.length > 0
      ? { destructive: true, title: "Some deployments still have tools denied" }
      : PHASE_COPY[phase.kind];
  const skipBlocked = phase.kind === "blocked" ? searchSkipping(search, phase.step) : undefined;
  const rotation = search.kind === "rotate" ? search : undefined;
  const rotateAgain =
    rotation !== undefined &&
    connectionActions(observation.old, access).includes("rotate") &&
    (phase.kind === "awaiting-verification" ||
      phase.kind === "verification-failed" ||
      (phase.kind === "blocked" && phase.step.kind === "verify"));
  const authorizing =
    search.kind === "reauthorize" &&
    (phase.kind === "awaiting-authorization" ||
      phase.kind === "authorization-failed" ||
      phase.kind === "revoking-old")
      ? { phase, search }
      : undefined;
  const target =
    search.kind === "reauthorize" && phase.kind !== "authorization-failed"
      ? observation.target
      : undefined;
  const hasNext = "next" in phase || phase.kind === "blocked";
  const confirmable =
    canFinish && !authorizing && (hasNext || phase.kind === "verification-failed");
  const confirmed = target === undefined || confirmedTarget === target.id;
  const startedBy = search.kind === "reauthorize" ? "reauthorization" : "rotation";
  const workspaceNames = new Map<string, string>(
    (workspaces.data ?? []).map((workspace) => [workspace.id, workspace.name]),
  );
  const connectionPath = `${environmentPath(scope)}/connections/${connectionId}`;
  const restart = (next: RebindSearch) => {
    onSearch(next);
    runner.mutate(next);
  };

  return (
    <div className="flex flex-col gap-8">
      <Text>
        {search.kind === "reauthorize" ? (
          <>
            Reauthorizing <TextLink href={connectionPath}>{observation.old.displayName}</TextLink>{" "}
            authorizes a new connection, verifies it, recreates the grants in the same workspaces,
            re-pins deployments to them, and then revokes the old connection.
          </>
        ) : search.since ? (
          <>
            Restoring the grants and pins of{" "}
            <TextLink href={connectionPath}>{observation.old.displayName}</TextLink> that the
            credential rotation at <Timestamp value={search.since} /> revoked.
          </>
        ) : (
          <>
            Restoring pins of{" "}
            <TextLink href={connectionPath}>{observation.old.displayName}</TextLink>. No rotation
            start is known here, so choose which revoked grants to restore.
          </>
        )}{" "}
        Each Continue reads the current state first, so you can stop, reload, or finish from another
        browser.
      </Text>
      {target ? (
        <ReauthorizeTarget
          confirmed={confirmed}
          old={observation.old}
          onConfirm={
            confirmable
              ? (checked) => setConfirmedTarget(checked ? target.id : undefined)
              : undefined
          }
          target={target}
        />
      ) : null}
      <Callout variant={copy.destructive ? "destructive" : "default"}>
        <CalloutTitle>{copy.title}</CalloutTitle>
        <CalloutDescription>
          <PhaseDetail observation={observation} phase={phase} search={search} />
        </CalloutDescription>
      </Callout>
      {authorizing ? (
        access.beginProviderAuthorization && access.revokeProviderConnection ? (
          <ReauthorizeControls
            observation={observation}
            phase={authorizing.phase}
            scope={scope}
            search={authorizing.search}
          />
        ) : (
          <Callout>
            <CalloutTitle>An owner or admin must finish this</CalloutTitle>
            <CalloutDescription>
              Reauthorizing needs permission to authorize providers and revoke connections.
            </CalloutDescription>
          </Callout>
        )
      ) : canFinish ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={runner.isPending || !hasNext || !confirmed}
            onClick={() => runner.mutate(search)}
          >
            {runner.isPending ? "Working…" : "Continue"}
          </Button>
          {skipBlocked ? (
            <Button
              disabled={runner.isPending || !confirmed}
              onClick={() => restart(skipBlocked)}
              variant="outline"
            >
              Skip and continue
            </Button>
          ) : null}
          {phase.kind === "verification-failed" ? (
            <Button
              disabled={runner.isPending || !confirmed}
              onClick={() => {
                const { verification: _verification, ...retry } = search;
                runner.mutate(retry);
              }}
              variant="outline"
            >
              Verify again
            </Button>
          ) : null}
          {rotateAgain ? (
            <Button disabled={runner.isPending} onClick={() => setRotating(true)} variant="outline">
              Rotate again
            </Button>
          ) : null}
        </div>
      ) : (
        <Callout>
          <CalloutTitle>An owner or admin must finish this</CalloutTitle>
          <CalloutDescription>
            Restoring grants and pins needs permission to verify connections, create grants, and
            update deployments.
          </CalloutDescription>
        </Callout>
      )}
      {problem ? (
        <Callout variant="destructive">
          <CalloutTitle>{problem.title}</CalloutTitle>
          <CalloutDescription>
            {problem.description ? <p>{problem.description}</p> : null}
            <ProblemReference requestId={problem.requestId} status={problem.status} />
          </CalloutDescription>
        </Callout>
      ) : null}
      {phase.kind === "done" && phase.needsOperator.length > 0 ? (
        <NeedsOperator
          deploymentIds={phase.needsOperator}
          deployments={observation.deployments}
          scope={scope}
        />
      ) : null}
      <section className="flex flex-col gap-4">
        <Subheading>Grants to restore</Subheading>
        {plan.templates.length === 0 ? (
          <Text>
            {search.kind === "reauthorize"
              ? "The old connection has no grants to restore."
              : search.since
                ? "The rotation revoked no grants, so there is nothing to restore."
                : "No grant is chosen for restoring yet."}
          </Text>
        ) : (
          <TemplateTable
            busy={runner.isPending}
            canEdit={canFinish}
            onToggleSkip={(template) =>
              onSearch({ ...search, skip: toggled(search.skip, template.grant.id) })
            }
            templates={plan.templates}
            workspaces={workspaceNames}
          />
        )}
      </section>
      {plan.revokedEarlier.length > 0 ? (
        <section className="flex flex-col gap-4">
          <Subheading>Revoked earlier and still pinned</Subheading>
          <Text>
            {search.kind === "reauthorize" || search.since
              ? `These grants were revoked before the ${startedBy}, so they stay revoked unless you restore them.`
              : "Live deployments pin these revoked grants, so the runtime denies their tools. Restore the ones they still need."}
          </Text>
          <EarlierTable
            busy={runner.isPending}
            canEdit={canFinish}
            earlier={plan.revokedEarlier}
            onToggle={(revocation) =>
              onSearch({ ...search, include: toggled(search.include, revocation.grant.id) })
            }
            workspaces={workspaceNames}
          />
        </section>
      ) : null}
      {rotateAgain ? (
        <RotateCredentialDialog
          connection={observation.old}
          deployments={observation.deployments}
          grants={observation.grants}
          onClose={() => setRotating(false)}
          onSubmit={rereadOnConflict(queryClient, observationQuery.queryKey)}
          open={rotating}
          rebind={rotation}
          scope={scope}
        />
      ) : null}
    </div>
  );
}
