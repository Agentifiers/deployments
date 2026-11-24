import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { invalidateAgent } from "../../data/agent-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { promoteAgentReleaseFn, publishAgentReleaseFn } from "../../data/release-mutations.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { AgentDetail, AgentReleaseSummary } from "../../server/agent-data.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";
import type { AgentRelease } from "../../server/release-data.ts";
import { Description, Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Code, Strong } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { ManifestDiffView } from "./manifest-diff-view.tsx";
import { ManifestView } from "./manifest-view.tsx";
import { ContentHash } from "./release-table.tsx";

/**
 * Publishes the draft at the definition version on screen, so a concurrent edit is rejected. It
 * shows what the release changes: the diff from the latest release, or the whole first manifest.
 */
export function PublishDraftDialog({
  agent,
  environment,
  latestManifest,
  latestNumber,
  onClose,
  open,
  scope,
}: Readonly<{
  agent: AgentDetail;
  environment: EnvironmentSummary;
  latestManifest: unknown;
  latestNumber: number | undefined;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { definition } = agent;
  return (
    <ActionDialog
      confirmLabel="Publish release"
      confirmation={typedConfirmation(environment.type, { phrase: definition.slug })}
      description={
        <>
          Publishes draft {definition.version} of <Strong>{definition.name}</Strong> as release #
          {(latestNumber ?? 0) + 1}. Releases are immutable; deployments keep their current release
          until you retarget them.
        </>
      }
      onClose={onClose}
      onSuccess={() => void invalidateAgent(queryClient, scope, definition.id)}
      open={open}
      run={(idempotencyKey) =>
        publishAgentReleaseFn({
          data: {
            body: { expectedDefinitionVersion: definition.version },
            definitionId: definition.id,
            idempotencyKey,
            scope,
          },
        })
      }
      size="3xl"
      successMessage="Draft published"
      title="Publish the draft"
    >
      {latestNumber === undefined ? (
        <ManifestView label="Manifest of release #1" manifest={definition.draft} />
      ) : (
        <ManifestDiffView
          baseline={latestManifest}
          baselineLabel={`release #${latestNumber}`}
          candidate={definition.draft}
          candidateLabel={`draft ${definition.version}`}
        />
      )}
    </ActionDialog>
  );
}

/** Other active environments of this project; the API promotes only within a project. */
function promotionTargets(
  projects: readonly { readonly environments: readonly EnvironmentSummary[] }[],
  scope: EnvironmentScope,
) {
  return projects
    .flatMap((project) => project.environments)
    .filter(
      (environment) =>
        environment.projectId === scope.projectId &&
        environment.id !== scope.environmentId &&
        environment.status === "active",
    );
}

/**
 * Copies one release into another environment of the project. The target agent is matched by
 * slug (and created when missing); its draft and deployments are left alone.
 */
export function PromoteReleaseDialog({
  agent,
  onClose,
  onPromoted,
  release,
  scope,
}: Readonly<{
  agent: AgentDetail;
  onClose: () => void;
  onPromoted: (release: AgentRelease, target: EnvironmentSummary) => void;
  release: AgentReleaseSummary | undefined;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const targets = promotionTargets(shell.projects, scope);
  const [targetId, setTargetId] = useState<string>();
  const target = targets.find((environment) => environment.id === targetId) ?? targets[0];
  return (
    <ActionDialog
      confirmLabel="Copy release"
      confirmation={
        target ? typedConfirmation(target.type, { live: true, phrase: target.slug }) : undefined
      }
      description={
        release ? (
          <>
            Copies release #{release.releaseNumber} (<ContentHash value={release.contentHash} />) to
            the agent with slug <Code>{agent.definition.slug}</Code> in the target environment,
            creating that agent if it does not exist. Its draft and deployments are unchanged;
            deploy the copied release there separately. Copying the same content twice returns the
            existing release.
          </>
        ) : null
      }
      invalid={!target}
      onClose={onClose}
      onSuccess={(promoted: AgentRelease) => {
        if (!target) return;
        void invalidateAgent(
          queryClient,
          {
            environmentId: promoted.environmentId,
            organizationId: promoted.organizationId,
            projectId: promoted.projectId,
          },
          promoted.agentDefinitionId,
        );
        onPromoted(promoted, target);
      }}
      open={release !== undefined}
      run={(idempotencyKey) =>
        promoteAgentReleaseFn({
          data: {
            body: { targetEnvironmentId: target?.id ?? "" },
            idempotencyKey,
            releaseId: release?.id ?? "",
            scope,
          },
        })
      }
      successMessage="Release copied"
      title={
        release
          ? `Copy release #${release.releaseNumber} to another environment`
          : "Copy release to another environment"
      }
    >
      {targets.length === 0 ? (
        <Description>This project has no other active environment to copy to.</Description>
      ) : (
        <Field>
          <Label>Target environment</Label>
          <NativeSelect
            name="targetEnvironmentId"
            onChange={(event) => setTargetId(event.target.value)}
            value={target?.id ?? ""}
          >
            {targets.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name} ({environment.type})
              </option>
            ))}
          </NativeSelect>
          <Description>Releases move between environments of the same project only.</Description>
        </Field>
      )}
    </ActionDialog>
  );
}
