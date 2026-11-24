import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { archiveAgentDefinitionFn } from "../../data/agent-mutations.ts";
import { invalidateAgent } from "../../data/agent-queries.ts";
import { archiveAgentReleaseFn } from "../../data/release-mutations.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { AgentDetail, AgentReleaseSummary } from "../../server/agent-data.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";
import { Button } from "@/components/ui/button";
import { Subheading } from "@/components/ui/heading";
import { Code, Strong, Text } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { liveDeployments } from "./agent-header.tsx";

/** Whether a deployment that is not stopped pins the release or runs it as a canary. */
export function releaseInUse(agent: AgentDetail, releaseId: string) {
  return liveDeployments(agent).some(
    (deployment) =>
      deployment.agentReleaseId === releaseId || deployment.candidateAgentReleaseId === releaseId,
  );
}

/**
 * Archives the definition at the version on screen. Deployments keep running the releases they
 * pin; archiving only closes editing and publishing.
 */
export function ArchiveAgentSection({
  agent,
  environment,
  scope,
}: Readonly<{ agent: AgentDetail; environment: EnvironmentSummary; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { definition } = agent;
  const live = liveDeployments(agent).length;
  if (definition.status !== "active") return null;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-red-500/30 p-4">
      <Subheading>Archive this agent</Subheading>
      <Text>
        An archived agent cannot be edited or published. Its releases stay, and deployments keep
        running until you stop them.
      </Text>
      <Button className="self-start" onClick={() => setOpen(true)} variant="destructive">
        Archive agent
      </Button>
      <ActionDialog
        confirmLabel="Archive agent"
        confirmation={typedConfirmation(environment.type, {
          destructive: true,
          phrase: definition.slug,
        })}
        description={
          <>
            Archives <Strong>{definition.name}</Strong> (<Code>{definition.slug}</Code>) at draft
            version {definition.version}. This cannot be undone.
            {live > 0
              ? ` ${live} live ${live === 1 ? "deployment keeps" : "deployments keep"} running; stop ${live === 1 ? "it" : "them"} from the Deployments tab.`
              : ""}
          </>
        }
        destructive
        onClose={() => setOpen(false)}
        onSuccess={() => void invalidateAgent(queryClient, scope, definition.id)}
        open={open}
        run={(idempotencyKey) =>
          archiveAgentDefinitionFn({
            data: {
              body: { expectedVersion: definition.version },
              definitionId: definition.id,
              idempotencyKey,
              scope,
            },
          })
        }
        successMessage="Agent archived"
        title={`Archive ${definition.name}`}
      />
    </section>
  );
}

/** Archives one release no live deployment uses; it can no longer be deployed or promoted. */
export function ArchiveReleaseDialog({
  agent,
  environment,
  onClose,
  release,
  scope,
}: Readonly<{
  agent: AgentDetail;
  environment: EnvironmentSummary;
  onClose: () => void;
  release: AgentReleaseSummary | undefined;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const phrase = release ? `#${release.releaseNumber}` : "";
  return (
    <ActionDialog
      confirmLabel="Archive release"
      confirmation={typedConfirmation(environment.type, { destructive: true, phrase })}
      description={
        release ? (
          <>
            Archives release #{release.releaseNumber} of <Strong>{agent.definition.name}</Strong>.
            It can no longer be deployed, used as a canary, or promoted. This cannot be undone.
          </>
        ) : null
      }
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateAgent(queryClient, scope, agent.definition.id)}
      open={release !== undefined}
      run={(idempotencyKey) =>
        archiveAgentReleaseFn({
          data: {
            body: { expectedVersion: release?.version ?? 0 },
            idempotencyKey,
            releaseId: release?.id ?? "",
            scope,
          },
        })
      }
      successMessage="Release archived"
      title={release ? `Archive release #${release.releaseNumber}` : "Archive release"}
    />
  );
}
