import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  abortAgentDeploymentCanaryFn,
  promoteAgentDeploymentCanaryFn,
  startAgentDeploymentCanaryFn,
  stopAgentDeploymentFn,
  updateAgentDeploymentFn,
} from "../../data/agent-mutations.ts";
import { invalidateAgent } from "../../data/agent-queries.ts";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import type { OperationAccess } from "../../access.ts";
import { PlatformApiError } from "../../errors.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";
import type { AgentDeployment, AgentDetail, AgentReleaseSummary } from "../../server/agent-data.ts";
import { Button } from "@/components/ui/button";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/reui/number-field";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { releaseLabel } from "./agent-header.tsx";

type DeploymentAction = "abort" | "canary" | "pause" | "promote" | "resume" | "retarget" | "stop";

const DEFAULT_CANARY_WEIGHT = "10";

/** What every agent action needs: scope, access, environment type, and submission helpers. */
export interface AgentActions {
  readonly access: OperationAccess;
  readonly environmentType: EnvironmentSummary["type"];
  /** Refetches the agent, the agents list, and the agent directory. */
  readonly refresh: () => Promise<unknown>;
  readonly scope: EnvironmentScope;
  /**
   * Runs one mutation. A 409 (stale `expectedVersion`, a canary started elsewhere) means the
   * agent changed while the dialog was open: its data is re-read so the next submission sends
   * the current version, and the dialog shows the problem.
   */
  readonly submit: <Result>(mutation: Promise<Result>) => Promise<Result>;
}

/** Scope, access, and environment type for agent mutations, plus conflict-aware submission. */
function useAgentActions(agent: AgentDetail): AgentActions {
  const { definition } = agent;
  const scope: EnvironmentScope = {
    environmentId: definition.environmentId,
    organizationId: definition.organizationId,
    projectId: definition.projectId,
  };
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const queryClient = useQueryClient();
  const refresh = () => invalidateAgent(queryClient, scope, definition.id);
  return {
    access: shell.access,
    environmentType: environment.type,
    refresh,
    scope,
    async submit(mutation) {
      try {
        return await mutation;
      } catch (error) {
        if (error instanceof PlatformApiError && error.problem.status === 409) void refresh();
        throw error;
      }
    },
  };
}

/** Active releases, newest first (the agent detail lists them newest first). */
function activeReleases(agent: AgentDetail) {
  return agent.releases.filter((release) => release.status === "active");
}

/** What a user types to confirm a deployment action: the ID tail `PublicId` displays. */
export function deploymentPhrase(deployment: { readonly id: string }) {
  return deployment.id.slice(-8);
}

export function ReleaseSelect({
  label,
  onChange,
  releases,
  value,
}: Readonly<{
  label: string;
  onChange: (releaseId: string) => void;
  releases: readonly AgentReleaseSummary[];
  value: string;
}>) {
  return (
    <Field>
      <Label>{label}</Label>
      <NativeSelect name="release" onChange={(event) => onChange(event.target.value)} value={value}>
        {releases.map((release) => (
          <option key={release.id} value={release.id}>
            #{release.releaseNumber} · {release.contentHash.slice(7, 19)} · created{" "}
            {release.createdAt.slice(0, 10)}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

interface DeploymentDialogProps {
  readonly actions: AgentActions;
  readonly agent: AgentDetail;
  readonly deployment: AgentDeployment;
  readonly onClose: () => void;
  readonly open: boolean;
}

function DesiredStateDialog({
  actions,
  deployment,
  desiredState,
  onClose,
  open,
}: DeploymentDialogProps & { readonly desiredState: "paused" | "running" }) {
  const verb = desiredState === "paused" ? "Pause" : "Resume";
  return (
    <ActionDialog
      confirmLabel={verb}
      confirmation={typedConfirmation(actions.environmentType, {
        live: true,
        phrase: deploymentPhrase(deployment),
      })}
      description={
        desiredState === "paused"
          ? "Sets the deployment's desired state to paused. Resume it to set it running again."
          : "Sets the deployment's desired state to running. The API re-admits its releases against the environment's model policy."
      }
      onClose={onClose}
      onSuccess={() => void actions.refresh()}
      open={open}
      run={(idempotencyKey) =>
        actions.submit(
          updateAgentDeploymentFn({
            data: {
              body: { desiredState, expectedVersion: deployment.version },
              deploymentId: deployment.id,
              idempotencyKey,
              scope: actions.scope,
            },
          }),
        )
      }
      successMessage={desiredState === "paused" ? "Deployment paused" : "Deployment resumed"}
      title={`${verb} deployment …${deploymentPhrase(deployment)}`}
    />
  );
}

function RetargetDialog({ actions, agent, deployment, onClose, open }: DeploymentDialogProps) {
  const targets = activeReleases(agent).filter(
    (release) => release.id !== deployment.agentReleaseId,
  );
  const [releaseId, setReleaseId] = useState(targets[0]?.id ?? "");
  return (
    <ActionDialog
      confirmLabel="Retarget"
      confirmation={typedConfirmation(actions.environmentType, {
        live: true,
        phrase: deploymentPhrase(deployment),
      })}
      description={`Pins the deployment to another active release of this agent instead of ${releaseLabel(agent, deployment.agentReleaseId)}. Use an earlier release to roll back.`}
      invalid={!targets.some((release) => release.id === releaseId)}
      onClose={onClose}
      onSuccess={() => void actions.refresh()}
      open={open}
      run={(idempotencyKey) =>
        actions.submit(
          updateAgentDeploymentFn({
            data: {
              body: { agentReleaseId: releaseId, expectedVersion: deployment.version },
              deploymentId: deployment.id,
              idempotencyKey,
              scope: actions.scope,
            },
          }),
        )
      }
      successMessage="Deployment retargeted"
      title={`Retarget deployment …${deploymentPhrase(deployment)}`}
    >
      <ReleaseSelect label="Release" onChange={setReleaseId} releases={targets} value={releaseId} />
    </ActionDialog>
  );
}

function StartCanaryDialog({ actions, agent, deployment, onClose, open }: DeploymentDialogProps) {
  const candidates = activeReleases(agent).filter(
    (release) => release.id !== deployment.agentReleaseId,
  );
  const [releaseId, setReleaseId] = useState(candidates[0]?.id ?? "");
  const [weightText, setWeightText] = useState(DEFAULT_CANARY_WEIGHT);
  const weight = Number(weightText);
  const weightValid = Number.isInteger(weight) && weight >= 1 && weight <= 99;
  return (
    <ActionDialog
      confirmLabel="Start canary"
      confirmation={typedConfirmation(actions.environmentType, {
        live: true,
        phrase: deploymentPhrase(deployment),
      })}
      description={`Routes a share of new threads to a candidate release; the rest stay on ${releaseLabel(agent, deployment.agentReleaseId)}. Promote or abort the canary when done.`}
      invalid={!weightValid || !candidates.some((release) => release.id === releaseId)}
      onClose={onClose}
      onSuccess={() => void actions.refresh()}
      open={open}
      run={(idempotencyKey) =>
        actions.submit(
          startAgentDeploymentCanaryFn({
            data: {
              body: {
                candidateAgentReleaseId: releaseId,
                expectedVersion: deployment.version,
                weight,
              },
              deploymentId: deployment.id,
              idempotencyKey,
              scope: actions.scope,
            },
          }),
        )
      }
      successMessage="Canary started"
      title={`Start a canary on deployment …${deploymentPhrase(deployment)}`}
    >
      <ReleaseSelect
        label="Candidate release"
        onChange={setReleaseId}
        releases={candidates}
        value={releaseId}
      />
      <Field>
        <Label>Candidate weight (%)</Label>
        <Description>Share of new threads routed to the candidate, from 1 to 99.</Description>
        <NumberField
          allowOutOfRange
          max={99}
          min={1}
          name="weight"
          onValueChange={(next) => setWeightText(next === null ? "" : String(next))}
          step={1}
          value={weightText.trim() === "" || !Number.isFinite(weight) ? null : weight}
        >
          <NumberFieldGroup className="has-aria-invalid:border-destructive has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20 dark:has-aria-invalid:ring-destructive/40">
            <NumberFieldDecrement />
            <NumberFieldInput
              aria-invalid={!weightValid}
              onChange={(event) => setWeightText(event.currentTarget.value)}
            />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
        {weightValid ? null : <ErrorMessage>Enter a whole number from 1 to 99.</ErrorMessage>}
      </Field>
    </ActionDialog>
  );
}

function ResolveCanaryDialog({
  actions,
  agent,
  deployment,
  onClose,
  open,
  resolution,
}: DeploymentDialogProps & { readonly resolution: "abort" | "promote" }) {
  const primary = releaseLabel(agent, deployment.agentReleaseId);
  const candidate = deployment.candidateAgentReleaseId
    ? releaseLabel(agent, deployment.candidateAgentReleaseId)
    : "the candidate";
  const promote = resolution === "promote";
  const resolve = promote ? promoteAgentDeploymentCanaryFn : abortAgentDeploymentCanaryFn;
  return (
    <ActionDialog
      confirmLabel={promote ? "Promote canary" : "Abort canary"}
      confirmation={typedConfirmation(actions.environmentType, {
        destructive: !promote,
        live: true,
        phrase: deploymentPhrase(deployment),
      })}
      description={
        promote
          ? `Makes ${candidate} the deployment's primary release and ends the canary.`
          : `Ends the canary: every new thread goes to ${primary} again, and ${candidate} stops receiving traffic.`
      }
      destructive={!promote}
      onClose={onClose}
      onSuccess={() => void actions.refresh()}
      open={open}
      run={(idempotencyKey) =>
        actions.submit(
          resolve({
            data: {
              body: { expectedVersion: deployment.version },
              deploymentId: deployment.id,
              idempotencyKey,
              scope: actions.scope,
            },
          }),
        )
      }
      successMessage={promote ? "Canary promoted" : "Canary aborted"}
      title={`${promote ? "Promote" : "Abort"} the canary on deployment …${deploymentPhrase(deployment)}`}
    />
  );
}

function StopDialog({ actions, deployment, onClose, open }: DeploymentDialogProps) {
  return (
    <ActionDialog
      confirmLabel="Stop deployment"
      confirmation={typedConfirmation(actions.environmentType, {
        destructive: true,
        phrase: deploymentPhrase(deployment),
      })}
      description="Stopping ends the deployment and any canary on it. Stopped deployments cannot be resumed or updated; deploy a release again to serve traffic from a new deployment."
      destructive
      onClose={onClose}
      onSuccess={() => void actions.refresh()}
      open={open}
      run={(idempotencyKey) =>
        actions.submit(
          stopAgentDeploymentFn({
            data: {
              body: { expectedVersion: deployment.version },
              deploymentId: deployment.id,
              idempotencyKey,
              scope: actions.scope,
            },
          }),
        )
      }
      successMessage="Deployment stopped"
      title={`Stop deployment …${deploymentPhrase(deployment)}`}
    />
  );
}

/**
 * The operational actions a deployment allows in its state, each behind its operation's access
 * and a confirmation dialog. Stopped deployments cannot be changed, so they get none; retargeting
 * waits until a running canary is promoted or aborted, as the API requires.
 */
export function DeploymentActions({
  agent,
  deployment,
}: Readonly<{ agent: AgentDetail; deployment: AgentDeployment }>) {
  const actions = useAgentActions(agent);
  const { access } = actions;
  const [action, setAction] = useState<DeploymentAction | undefined>();
  const [open, setOpen] = useState(false);
  if (deployment.desiredState === "stopped") return null;
  const canary = deployment.candidateAgentReleaseId !== undefined;
  const otherRelease = activeReleases(agent).some(
    (release) => release.id !== deployment.agentReleaseId,
  );
  const available: readonly (readonly [DeploymentAction, string, boolean])[] = [
    ["pause", "Pause", access.updateAgentDeployment && deployment.desiredState === "running"],
    ["resume", "Resume", access.updateAgentDeployment && deployment.desiredState === "paused"],
    ["retarget", "Retarget", access.updateAgentDeployment && !canary && otherRelease],
    ["canary", "Start canary", access.startAgentDeploymentCanary && !canary && otherRelease],
    ["promote", "Promote canary", access.promoteAgentDeploymentCanary && canary],
    ["abort", "Abort canary", access.abortAgentDeploymentCanary && canary],
    ["stop", "Stop", access.stopAgentDeployment],
  ];
  const shown = available.filter(([, , allowed]) => allowed);
  if (shown.length === 0) return null;
  const props: DeploymentDialogProps = {
    actions,
    agent,
    deployment,
    onClose: () => setOpen(false),
    open,
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {shown.map(([name, label]) => (
        <Button
          key={name}
          onClick={() => {
            setAction(name);
            setOpen(true);
          }}
          variant="outline"
        >
          {label}
        </Button>
      ))}
      {action === "pause" || action === "resume" ? (
        <DesiredStateDialog {...props} desiredState={action === "pause" ? "paused" : "running"} />
      ) : null}
      {action === "retarget" ? <RetargetDialog {...props} /> : null}
      {action === "canary" ? <StartCanaryDialog {...props} /> : null}
      {action === "promote" || action === "abort" ? (
        <ResolveCanaryDialog {...props} resolution={action} />
      ) : null}
      {action === "stop" ? <StopDialog {...props} /> : null}
    </div>
  );
}

export function DeployReleaseAction({ agent }: Readonly<{ agent: AgentDetail }>) {
  const { access, scope } = useAgentActions(agent);
  if (!access.createAgentDeployment || activeReleases(agent).length === 0) return null;
  return (
    <Button href={`${environmentPath(scope)}/agents/${agent.definition.id}/deploy`}>
      Deploy release
    </Button>
  );
}
