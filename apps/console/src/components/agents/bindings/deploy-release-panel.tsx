import { RocketIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ToolBindingChanges } from "../../../agents/runtime-config.ts";
import { bindingModel } from "../../../agents/tool-bindings.ts";
import { agentDetailQuery } from "../../../data/agent-queries.ts";
import { environmentQuery, organizationShellQuery } from "../../../data/console-queries.ts";
import { bindingWorkbenchQuery } from "../../../data/tool-binding-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Description, Field, FieldGroup, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { NativeSelect } from "@/components/ui/native-select";
import { Icon } from "../../icon.tsx";
import { SectionBoundary } from "../../section-boundary.tsx";
import { releaseLabel } from "../agent-header.tsx";
import { deploymentPhrase, ReleaseSelect } from "../deployment-actions.tsx";
import { DeployDialog } from "./binding-dialogs.tsx";
import { BindingsEditor } from "./bindings-editor.tsx";

const NO_SEED = "";

export interface DeploySearch {
  readonly release?: string;
  readonly seed?: string;
}

interface PanelProps {
  readonly definitionId: string;
  readonly onSearch: (search: DeploySearch) => void;
  readonly scope: EnvironmentScope;
  readonly search: DeploySearch;
}

function Editor({
  definitionId,
  desiredState,
  releaseId,
  scope,
  seedId,
}: Readonly<{
  definitionId: string;
  desiredState: "paused" | "running";
  releaseId: string;
  scope: EnvironmentScope;
  seedId: string | undefined;
}>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const { data: workbench } = useSuspenseQuery(
    bindingWorkbenchQuery(
      scope,
      {
        definitionId,
        kind: "deploy",
        releaseId,
        ...(seedId ? { seedDeploymentId: seedId } : {}),
      },
      shell.access.listModels,
    ),
  );
  const [choices, setChoices] = useState<ToolBindingChanges>({});
  const [open, setOpen] = useState(false);
  const model = bindingModel(workbench, choices);
  const { target } = workbench;
  return (
    <div className="flex flex-col gap-6">
      <BindingsEditor
        definitionId={definitionId}
        model={model}
        onChoose={(tool, binding) => setChoices((current) => ({ ...current, [tool]: binding }))}
        scope={scope}
        workbench={workbench}
      />
      <div>
        <Button disabled={!model.submittable} onClick={() => setOpen(true)}>
          Deploy
        </Button>
      </div>
      {target.kind === "new" ? (
        <DeployDialog
          definitionId={definitionId}
          desiredState={desiredState}
          environmentType={environment.type}
          model={model}
          onClose={() => setOpen(false)}
          open={open}
          phrase={agent.definition.slug}
          releaseId={target.releaseId}
          releaseName={releaseLabel(agent, target.releaseId)}
          scope={scope}
          {...(target.seed ? { seed: target.seed } : {})}
        />
      ) : null}
    </div>
  );
}

/**
 * Deploys an active release with tool bindings chosen per tool, optionally starting from a live
 * deployment's configuration, whose sub-agent bindings and other settings carry over.
 */
export function DeployReleasePanel({ definitionId, onSearch, scope, search }: PanelProps) {
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const [desiredState, setDesiredState] = useState<"paused" | "running">("running");
  const releases = agent.releases.filter(({ status }) => status === "active");
  const seeds = agent.deployments.filter(
    ({ desiredState: state, runtimeConfig }) => state !== "stopped" && runtimeConfig,
  );
  const release = releases.find(({ id }) => id === search.release) ?? releases[0];
  const seed = seeds.find(({ id }) => id === search.seed);
  const back = (
    <Button href={`${environmentPath(scope)}/agents/${definitionId}/deployments`} variant="outline">
      Back to deployments
    </Button>
  );
  if (!release) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon icon={RocketIcon} />
          </EmptyMedia>
          <EmptyTitle>No active release</EmptyTitle>
          <EmptyDescription>
            Publish a release from the agent&apos;s configuration to deploy it.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button href={`${environmentPath(scope)}/agents/${definitionId}/configuration`}>
            Open configuration
          </Button>
          {back}
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Deploy a release</Subheading>
        <div className="ml-auto">{back}</div>
      </div>
      <FieldGroup className="grid gap-6 sm:grid-cols-3">
        <ReleaseSelect
          label="Release"
          onChange={(releaseId) => onSearch({ ...search, release: releaseId })}
          releases={releases}
          value={release.id}
        />
        <Field>
          <Label>Desired state</Label>
          <NativeSelect
            name="desiredState"
            onChange={(event) =>
              setDesiredState(event.target.value === "paused" ? "paused" : "running")
            }
            value={desiredState}
          >
            <option value="running">Running</option>
            <option value="paused">Paused</option>
          </NativeSelect>
        </Field>
        <Field>
          <Label>Start from</Label>
          <NativeSelect
            name="seed"
            onChange={(event) =>
              onSearch({
                release: release.id,
                ...(event.target.value === NO_SEED ? {} : { seed: event.target.value }),
              })
            }
            value={seed?.id ?? NO_SEED}
          >
            <option value={NO_SEED}>No existing configuration</option>
            {seeds.map((deployment) => (
              <option key={deployment.id} value={deployment.id}>
                Deployment …{deploymentPhrase(deployment)} (
                {releaseLabel(agent, deployment.agentReleaseId)})
              </option>
            ))}
          </NativeSelect>
          <Description>
            Copies its tool bindings, sub-agent bindings, and other settings; edit the tool bindings
            below.
          </Description>
        </Field>
      </FieldGroup>
      <SectionBoundary resetKey={`${release.id}:${seed?.id ?? NO_SEED}`}>
        <Editor
          definitionId={definitionId}
          desiredState={desiredState}
          releaseId={release.id}
          scope={scope}
          seedId={seed?.id}
        />
      </SectionBoundary>
    </section>
  );
}
