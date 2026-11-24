import { useSuspenseQuery } from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import { useState } from "react";
import type { ToolBindingChanges } from "../../../agents/runtime-config.ts";
import { bindingModel } from "../../../agents/tool-bindings.ts";
import { isRepinnable } from "../../../connections/rebind.ts";
import { agentDetailQuery } from "../../../data/agent-queries.ts";
import { environmentQuery, organizationShellQuery } from "../../../data/console-queries.ts";
import { bindingWorkbenchQuery } from "../../../data/tool-binding-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Subheading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";
import { PublicId } from "../../public-id.tsx";
import { SectionBoundary } from "../../section-boundary.tsx";
import { releaseLabel } from "../agent-header.tsx";
import { SaveBindingsDialog } from "./binding-dialogs.tsx";
import { BindingsEditor } from "./bindings-editor.tsx";

interface PanelProps {
  readonly definitionId: string;
  readonly deploymentId: string;
  readonly scope: EnvironmentScope;
}

function Editor({
  definitionId,
  deploymentId,
  desiredState,
  scope,
}: PanelProps & { readonly desiredState: "paused" | "running" }) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: workbench } = useSuspenseQuery(
    bindingWorkbenchQuery(
      scope,
      { definitionId, deploymentId, kind: "edit" },
      shell.access.listModels,
    ),
  );
  const [choices, setChoices] = useState<ToolBindingChanges>({});
  const [open, setOpen] = useState(false);
  const model = bindingModel(workbench, choices);
  const canSave = shell.access.updateAgentDeployment;
  const { target } = workbench;
  return (
    <div className="flex flex-col gap-6">
      <BindingsEditor
        definitionId={definitionId}
        model={model}
        onChoose={(tool, binding) => setChoices((current) => ({ ...current, [tool]: binding }))}
        readOnly={!canSave}
        scope={scope}
        workbench={workbench}
      />
      {canSave && target.kind === "existing" ? (
        <div className="flex items-center gap-3">
          <Button disabled={!model.submittable} onClick={() => setOpen(true)}>
            Save bindings
          </Button>
          <Button onClick={() => setChoices({})} variant="ghost">
            Discard changes
          </Button>
          <SaveBindingsDialog
            definitionId={definitionId}
            deploymentId={deploymentId}
            desiredState={desiredState}
            environmentType={environment.type}
            expectedVersion={target.version}
            model={model}
            onClose={() => setOpen(false)}
            onSaved={() => setChoices({})}
            open={open}
            policies={workbench.policies}
            scope={scope}
          />
        </div>
      ) : (
        <Text>Your role or token scopes do not permit changing deployments (agents:write).</Text>
      )}
    </div>
  );
}

/**
 * Edit tool bindings on one deployment. Saving sets the deployment's state to ready or paused,
 * so only a ready or paused deployment that is not stopped can be edited.
 */
export function EditBindingsPanel({ definitionId, deploymentId, scope }: PanelProps) {
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const deployment = agent.deployments.find(({ id }) => id === deploymentId);
  if (!deployment) throw notFound();
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Tool bindings</Subheading>
        <span className="flex items-center gap-2 text-sm/6 text-muted-foreground">
          Deployment <PublicId value={deployment.id} /> ·{" "}
          {releaseLabel(agent, deployment.agentReleaseId)}
          {deployment.candidateAgentReleaseId
            ? ` with canary ${releaseLabel(agent, deployment.candidateAgentReleaseId)}`
            : ""}{" "}
          · {deployment.currentState}
        </span>
        <Button
          className="ml-auto"
          href={`${environmentPath(scope)}/agents/${definitionId}/deployments`}
          variant="outline"
        >
          Back to deployments
        </Button>
      </div>
      {isRepinnable(deployment) ? (
        <SectionBoundary resetKey={deploymentId}>
          <Editor
            definitionId={definitionId}
            deploymentId={deploymentId}
            desiredState={deployment.desiredState}
            scope={scope}
          />
        </SectionBoundary>
      ) : (
        <Callout>
          <CalloutTitle>Resolve the deployment's state first</CalloutTitle>
          <CalloutDescription>
            This deployment is {deployment.currentState} with desired state{" "}
            {deployment.desiredState}. Saving bindings would reset its state, so only a ready or
            paused deployment can change them.
          </CalloutDescription>
        </Callout>
      )}
    </section>
  );
}
