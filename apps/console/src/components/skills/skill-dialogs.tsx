import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { applySkillPlanFn } from "../../data/managed-skill-mutations.ts";
import { invalidateSkillInstallations } from "../../data/managed-skill-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import {
  dependentsCheck,
  installPlan,
  planAction,
  planOperations,
  type AgentTarget,
  type AgentTargets,
  type DependentsCheck,
  type InstalledSkill,
  type InstallTarget,
  type PlanAction,
  type PlanStep,
  type ReleaseSummary,
  type SkillInstallations,
  type SkillSummary,
} from "../../skills/skill-state.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Description, Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Code, Text } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";

const ENVIRONMENT_VALUE = "environment";

export function targetLabel(target: InstallTarget, agents: readonly AgentTarget[]): string {
  if (target.kind === "environment") return "Whole environment";
  const agent = agents.find(({ id }) => id === target.agentDefinitionId);
  return agent ? agent.name : `Agent …${target.agentDefinitionId.slice(-8)}`;
}

function targetPhrase(target: InstallTarget, agents: readonly AgentTarget[]): string {
  return target.kind === "environment" ? "the whole environment" : targetLabel(target, agents);
}

function PlanList({
  plan,
  releaseVersion,
}: Readonly<{ plan: readonly PlanStep[]; releaseVersion: string }>) {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm/6 text-foreground">
      {plan.map((step) => {
        if (step.kind === "remove") {
          return (
            <li key={`remove:${step.installed.installation.id}`}>
              Remove <Code>{step.installed.skill.key}</Code> {step.installed.release.releaseVersion}
            </li>
          );
        }
        return step.kind === "keep" ? (
          <li key={`keep:${step.skill.id}`}>
            Confirm <Code>{step.skill.key}</Code> {releaseVersion} is installed
          </li>
        ) : (
          <li key={`install:${step.skill.id}`}>
            Install <Code>{step.skill.key}</Code> {releaseVersion}
            {step.reason === "dependency" ? ", a dependency" : ""}
          </li>
        );
      })}
    </ol>
  );
}

function DependentsNotice({
  agents,
  check: { partial, stranded },
}: Readonly<{ agents: readonly AgentTarget[]; check: DependentsCheck }>) {
  return (
    <>
      {stranded.length > 0 ? (
        <Callout variant="destructive">
          <CalloutTitle>
            {stranded.length === 1 ? "An installed skill" : `${stranded.length} installed skills`}{" "}
            {partial ? "may lose" : stranded.length === 1 ? "loses" : "lose"} a dependency
          </CalloutTitle>
          <CalloutDescription>
            {stranded.length === 1
              ? "It stays installed and reports the dependency missing"
              : "They stay installed and report the dependency missing"}
            {partial
              ? " unless an installation the console did not read provides that dependency"
              : ""}
            :
            <ul className="flex flex-col gap-1">
              {stranded.map(({ installation, release, skill }) => (
                <li key={installation.id}>
                  <Code>{skill.key}</Code> {release.releaseVersion} for{" "}
                  {targetPhrase(installation.target, agents)}
                </li>
              ))}
            </ul>
          </CalloutDescription>
        </Callout>
      ) : null}
      {partial ? (
        <Text>
          The environment has more installations than the console reads at once, so installed skills
          the console did not read may lose a dependency.
        </Text>
      ) : null}
    </>
  );
}

function usePlanRun(scope: EnvironmentScope, plan: readonly PlanStep[]) {
  const queryClient = useQueryClient();
  return (idempotencyKey: string) =>
    applySkillPlanFn({
      data: { idempotencyKey, operations: planOperations(plan), scope },
    }).finally(() => void invalidateSkillInstallations(queryClient, scope));
}

const RETRY_NOTICE =
  "Some steps may have run. Submitting again finishes the rest without repeating them.";

const ACTION_COPY: Readonly<
  Record<
    PlanAction,
    {
      readonly confirm: string;
      readonly done: (key: string, version: string) => string;
      readonly title: (key: string, version: string) => string;
    }
  >
> = {
  downgrade: {
    confirm: "Replace with older release",
    done: (key, version) => `${key} replaced with older release ${version}`,
    title: (key, version) => `Replace ${key} with older release ${version}`,
  },
  install: {
    confirm: "Install",
    done: (key, version) => `${key} ${version} installed`,
    title: (key, version) => `Install ${key} ${version}`,
  },
  upgrade: {
    confirm: "Upgrade",
    done: (key, version) => `${key} ${version} upgraded`,
    title: (key, version) => `Upgrade ${key} to ${version}`,
  },
};

export function InstallSkillDialog({
  installations,
  onClose,
  open,
  release,
  releaseSkills,
  scope,
  skill,
  targets,
}: Readonly<{
  installations: SkillInstallations;
  onClose: () => void;
  open: boolean;
  release: ReleaseSummary;
  releaseSkills: readonly SkillSummary[];
  scope: EnvironmentScope;
  skill: SkillSummary;
  targets: AgentTargets | undefined;
}>) {
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [targetValue, setTargetValue] = useState(ENVIRONMENT_VALUE);
  const [withDependencies, setWithDependencies] = useState(true);
  const target: InstallTarget =
    targetValue === ENVIRONMENT_VALUE
      ? { kind: "environment" }
      : { agentDefinitionId: targetValue, kind: "agent" };
  const planFor = (dependencies: boolean) =>
    installPlan({
      installed: installations.installed,
      releaseSkills,
      skill,
      target,
      withDependencies: dependencies,
    });
  const plan = planFor(withDependencies);
  const everyDependency = planFor(true);
  const missing =
    everyDependency.steps.filter((step) => step.kind === "install" && step.reason === "dependency")
      .length + everyDependency.unresolved.length;
  const current = plan.steps.every((step) => step.kind === "keep");
  const dependents = dependentsCheck(installations, plan.steps);
  const copy = ACTION_COPY[planAction(plan.steps, release.releaseVersion)];
  const run = usePlanRun(scope, plan.steps);
  const agents = targets?.agents ?? [];
  const activeAgents = agents
    .filter((agent) => agent.status === "active")
    .toSorted((left, right) => left.name.localeCompare(right.name));

  return (
    <ActionDialog
      confirmLabel={copy.confirm}
      confirmation={typedConfirmation(environment.type, {
        destructive: dependents.stranded.length > 0 || dependents.partial,
        phrase: skill.key,
      })}
      description="An installed skill lets the agent read its reference files with managed_skills.reference.read. It does not change the agent's prompt."
      invalid={current || plan.unresolved.length > 0}
      onClose={onClose}
      open={open}
      retryNotice={RETRY_NOTICE}
      run={run}
      successMessage={copy.done(skill.key, release.releaseVersion)}
      title={copy.title(skill.key, release.releaseVersion)}
    >
      <Field>
        <Label>Install for</Label>
        <NativeSelect onChange={(event) => setTargetValue(event.target.value)} value={targetValue}>
          <option value={ENVIRONMENT_VALUE}>Whole environment</option>
          {activeAgents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </NativeSelect>
        <Description>
          A run reads a skill installed for its agent first, then one installed for the whole
          environment.
          {targets === undefined
            ? " Your role or token scopes do not permit listing agents (agents:read), so only the whole environment is offered."
            : targets.complete
              ? null
              : " The environment has more agents than the console reads at once, so some are not listed."}
        </Description>
      </Field>
      {missing > 0 ? (
        <CheckboxField>
          <Checkbox checked={withDependencies} onCheckedChange={setWithDependencies} />
          <Label>
            Also install{" "}
            {missing === 1 ? "its missing dependency" : `its ${missing} missing dependencies`}
          </Label>
          <Description>
            Dependencies are skills of the same release. Nothing enforces them, so the skill
            installs without them, and the Installed tab reports them as missing.
          </Description>
        </CheckboxField>
      ) : null}
      {plan.unresolved.length > 0 ? (
        <Callout variant="destructive">
          <CalloutTitle>
            {plan.unresolved.length === 1
              ? "A dependency cannot be found"
              : `${plan.unresolved.length} dependencies cannot be found`}
          </CalloutTitle>
          <CalloutDescription>
            The console reads only part of the skills in this release, so it cannot install{" "}
            {plan.unresolved.map((id, index) => (
              <Fragment key={id}>
                {index > 0 ? ", " : null}
                <Code>{id}</Code>
              </Fragment>
            ))}
            . Clear the checkbox to install the skill without{" "}
            {plan.unresolved.length === 1 ? "it" : "them"}.
          </CalloutDescription>
        </Callout>
      ) : null}
      <DependentsNotice agents={agents} check={dependents} />
      {current ? (
        <Text>This release of the skill is already installed for this target.</Text>
      ) : (
        <div className="flex flex-col gap-2">
          <Text>{`For ${targetPhrase(target, agents)}, the console runs these steps in order:`}</Text>
          <PlanList plan={plan.steps} releaseVersion={release.releaseVersion} />
        </div>
      )}
    </ActionDialog>
  );
}

export function RemoveSkillDialog({
  agents,
  entry,
  installations,
  onClose,
  open,
  scope,
}: Readonly<{
  agents: readonly AgentTarget[];
  entry: InstalledSkill;
  installations: SkillInstallations;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const plan: readonly PlanStep[] = [{ installed: entry, kind: "remove" }];
  const run = usePlanRun(scope, plan);
  const dependents = dependentsCheck(installations, plan);
  const label = `${entry.skill.key} ${entry.release.releaseVersion}`;
  return (
    <ActionDialog
      confirmLabel="Remove"
      confirmation={entry.skill.key}
      description={`Installed for ${targetPhrase(entry.installation.target, agents)}. Runs it serves can no longer read its reference files.`}
      destructive
      onClose={onClose}
      open={open}
      run={run}
      successMessage={`${label} removed`}
      title={`Remove ${label}`}
    >
      <DependentsNotice agents={agents} check={dependents} />
      {dependents.stranded.length === 0 && !dependents.partial ? (
        <Text>Skills that depend on it stay installed and report it missing.</Text>
      ) : null}
    </ActionDialog>
  );
}
