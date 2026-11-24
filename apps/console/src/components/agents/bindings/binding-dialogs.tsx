import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  saveCause,
  type BindingModel,
  type BindingsWrite,
  type BindingWorkbench,
} from "../../../agents/tool-bindings.ts";
import { invalidateAgent } from "../../../data/agent-queries.ts";
import { deployReleaseFn, saveToolBindingsFn } from "../../../data/tool-binding-mutations.ts";
import type { PlatformProblem } from "../../../errors.ts";
import type { EnvironmentScope } from "../../../scope.ts";
import type { EnvironmentSummary } from "../../../server/console-data.ts";
import { Code } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../../action-dialog.tsx";
import { deploymentPhrase } from "../deployment-actions.tsx";

function problemAction(action: BindingsWrite) {
  return (problem: PlatformProblem): ReactNode => {
    const cause = saveCause(problem, action);
    return cause ? <p>{cause}</p> : null;
  };
}

function ChangeList({ model, policies }: Readonly<{ model: BindingModel; policies: Policies }>) {
  const changes = Object.entries(model.changes);
  const policyName = (id: string) =>
    policies.items.find((policy) => policy.id === id)?.name ?? `…${id.slice(-8)}`;
  return (
    <ul className="list-disc pl-5 text-sm/6">
      {changes.map(([tool, binding]) => (
        <li key={tool}>
          <Code>{tool}</Code>{" "}
          {binding
            ? `pins grant …${binding.authorizationId.slice(-8)} with ${binding.toolPolicyId ? `policy ${policyName(binding.toolPolicyId)}` : "no policy"}`
            : "is unbound"}
        </li>
      ))}
      {model.dropped.map((tool) => (
        <li key={tool}>
          <Code>{tool}</Code> binding is removed
        </li>
      ))}
    </ul>
  );
}

type Policies = BindingWorkbench["policies"];

interface DialogBase {
  readonly definitionId: string;
  readonly environmentType: EnvironmentSummary["type"];
  readonly model: BindingModel;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly policies: Policies;
  readonly scope: EnvironmentScope;
}

const SAVE_EFFECTS = {
  paused:
    "Saving replaces this deployment's runtime configuration, and it stays paused. The save also re-resolves its sub-agent bindings, which can refuse it. Resuming later re-admits its models.",
  running:
    "Saving replaces this deployment's runtime configuration and sets its state to ready. Because it runs, the save also re-admits its release's models against the environment's model policy and re-resolves its sub-agent bindings. Either check can refuse the save.",
} as const;

function useToolsTab(scope: EnvironmentScope, definitionId: string) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = {
    definitionId,
    envId: scope.environmentId,
    orgId: scope.organizationId,
    projectId: scope.projectId,
  };
  return {
    refresh: () => invalidateAgent(queryClient, scope, definitionId),
    /** After a deploy, the new deployment's Chat page is where to try it. */
    showChat: (deploymentId: string) => {
      void invalidateAgent(queryClient, scope, definitionId);
      void navigate({
        params: { ...params, deploymentId },
        to: "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/chat/$deploymentId",
      });
    },
    showTools: () => {
      void invalidateAgent(queryClient, scope, definitionId);
      void navigate({
        params,
        to: "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/tools",
      });
    },
  };
}

/**
 * Saves per-tool changes to a deployment. A 409 reloads the deployment; the page keeps the
 * operator's choices on top of the reloaded bindings.
 */
export function SaveBindingsDialog({
  definitionId,
  deploymentId,
  desiredState,
  environmentType,
  expectedVersion,
  model,
  onClose,
  onSaved,
  open,
  policies,
  scope,
}: DialogBase & {
  readonly deploymentId: string;
  readonly desiredState: keyof typeof SAVE_EFFECTS;
  readonly expectedVersion: number;
  readonly onSaved: () => void;
}) {
  const { refresh, showTools } = useToolsTab(scope, definitionId);
  return (
    <ActionDialog
      confirmLabel="Save bindings"
      confirmation={typedConfirmation(environmentType, {
        live: true,
        phrase: deploymentPhrase({ id: deploymentId }),
      })}
      description={SAVE_EFFECTS[desiredState]}
      invalid={!model.submittable}
      onClose={onClose}
      onSuccess={() => {
        onSaved();
        showTools();
      }}
      open={open}
      problemAction={problemAction("save")}
      run={(idempotencyKey) =>
        refreshOnConflict(
          saveToolBindingsFn({
            data: {
              changes: model.changes,
              definitionId,
              deploymentId,
              expectedVersion,
              idempotencyKey,
              scope,
            },
          }),
          refresh,
        )
      }
      successMessage="Tool bindings saved"
      title="Save tool bindings"
    >
      <ChangeList model={model} policies={policies} />
    </ActionDialog>
  );
}

export function DeployDialog({
  definitionId,
  desiredState,
  environmentType,
  model,
  onClose,
  open,
  phrase,
  releaseId,
  releaseName,
  scope,
  seed,
}: Omit<DialogBase, "policies"> & {
  readonly desiredState: "paused" | "running";
  readonly phrase: string;
  readonly releaseId: string;
  /** How the deploy page names the release, such as `#3`. */
  readonly releaseName: string;
  readonly seed?: { readonly deploymentId: string; readonly version: number };
}) {
  const { refresh, showChat } = useToolsTab(scope, definitionId);
  const changes = Object.keys(model.changes).length + model.dropped.length;
  const base = seed
    ? `deployment …${deploymentPhrase({ id: seed.deploymentId })}'s configuration`
    : "the default configuration";
  const edits =
    changes === 0 ? "" : ` and ${changes} tool binding ${changes === 1 ? "change" : "changes"}`;
  // The deploy page is the form: this one step states its outcome, without repeating the page's
  // choices, and in production asks for the typed confirmation inline.
  return (
    <ActionDialog
      confirmLabel="Deploy"
      confirmation={typedConfirmation(environmentType, { live: true, phrase })}
      description={`Creates a ${desiredState} deployment of release ${releaseName} from ${base}${edits}. Existing deployments keep their releases.`}
      invalid={!model.submittable}
      onClose={onClose}
      onSuccess={(deployment: { readonly id: string }) => showChat(deployment.id)}
      open={open}
      problemAction={problemAction("deploy")}
      retryNotice="The deployment may already exist. Submit again to finish. The retry reuses this request's key, so it creates at most one deployment."
      run={(idempotencyKey) =>
        refreshOnConflict(
          deployReleaseFn({
            data: {
              changes: model.changes,
              definitionId,
              desiredState,
              idempotencyKey,
              releaseId,
              scope,
              ...(seed ? { seed } : {}),
            },
          }),
          refresh,
        )
      }
      successMessage="Release deployed. You can chat with it now."
      title={`Deploy release ${releaseName}`}
    />
  );
}
