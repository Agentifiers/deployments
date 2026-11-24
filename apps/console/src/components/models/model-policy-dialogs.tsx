import type { ModelPolicyResponse } from "@deployments-ai/api-contract/models";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { environmentQuery } from "../../data/console-queries.ts";
import {
  archiveModelPolicyFn,
  createModelPolicyFn,
  updateModelPolicyFn,
} from "../../data/model-mutations.ts";
import { invalidateModels, modelPolicyPreviewQuery } from "../../data/model-queries.ts";
import { UnauthenticatedError } from "../../errors.ts";
import { impactCheck, impactIsDestructive } from "../../models/model-impact.ts";
import {
  draftRules,
  policyTransition,
  type ModelPolicyDraft,
  type NextRules,
} from "../../models/model-policy-state.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { describeProblem, ProblemReference } from "../section-boundary.tsx";
import { ModelImpactPanel } from "./model-impact.tsx";

function PreviewProblem({ error }: Readonly<{ error: Error }>) {
  if (error instanceof UnauthenticatedError) throw error;
  const problem = describeProblem(error, "The impact check failed");
  return (
    <Callout variant="destructive">
      <CalloutTitle>{problem.title}</CalloutTitle>
      <CalloutDescription>
        {problem.description ? <p>{problem.description}</p> : null}
        <p>Close the dialog and try again.</p>
        <ProblemReference requestId={problem.requestId} status={problem.status} />
      </CalloutDescription>
    </Callout>
  );
}

function usePolicyPreview(scope: EnvironmentScope, next: NextRules, open: boolean, phrase: string) {
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const check = impactCheck(useQuery({ ...modelPolicyPreviewQuery(scope, next), enabled: open }));
  switch (check.kind) {
    case "checking":
      return {
        body: <Text>Checking every live deployment&apos;s models…</Text>,
        confirmation: undefined,
        ready: false,
      };
    case "failed":
      return {
        body: <PreviewProblem error={check.error} />,
        confirmation: undefined,
        ready: false,
      };
    case "checked":
      return {
        body: <ModelImpactPanel preview={check.preview} scope={scope} />,
        confirmation: typedConfirmation(environment.type, {
          destructive: impactIsDestructive(check.preview.impact),
          phrase,
        }),
        ready: check.preview.issues.length === 0,
      };
    default: {
      const _exhaustive: never = check;
      return _exhaustive;
    }
  }
}

export function SaveModelPolicyDialog({
  active,
  draft,
  onClose,
  onSaved,
  open,
  scope,
}: Readonly<{
  active: ModelPolicyResponse | undefined;
  draft: ModelPolicyDraft;
  onClose: () => void;
  onSaved: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const transition = policyTransition(active, draft);
  const name = draft.name.trim();
  const preview = usePolicyPreview(scope, draftRules(draft), open, name);
  const refresh = () => invalidateModels(queryClient, scope);
  return (
    <ActionDialog
      confirmLabel={transition.kind === "create" ? "Create policy" : "Save policy"}
      confirmation={preview.confirmation}
      description="Saving takes effect for the next run of every deployment in this environment."
      invalid={!preview.ready}
      onClose={onClose}
      onSuccess={() => {
        void refresh();
        onSaved();
      }}
      open={open}
      run={(idempotencyKey: string) =>
        refreshOnConflict(
          transition.kind === "create"
            ? createModelPolicyFn({ data: { body: transition.body, idempotencyKey, scope } })
            : updateModelPolicyFn({
                data: {
                  body: transition.patch,
                  expectedVersion: transition.expectedVersion,
                  idempotencyKey,
                  policyId: transition.policyId,
                  scope,
                },
              }),
          refresh,
        )
      }
      size="2xl"
      successMessage={transition.kind === "create" ? "Model policy created" : "Model policy saved"}
      title={transition.kind === "create" ? `Create ${name}` : `Save ${name}`}
    >
      {preview.body}
    </ActionDialog>
  );
}

export function ArchiveModelPolicyDialog({
  onClose,
  open,
  policy,
  scope,
}: Readonly<{
  onClose: () => void;
  open: boolean;
  policy: ModelPolicyResponse;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const preview = usePolicyPreview(scope, null, open, policy.name);
  const refresh = () => invalidateModels(queryClient, scope);
  return (
    <ActionDialog
      confirmLabel="Archive policy"
      confirmation={preview.confirmation}
      description="The environment returns to the curated defaults: only curated models are allowed."
      destructive
      invalid={!preview.ready}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={open}
      run={(idempotencyKey: string) =>
        refreshOnConflict(
          archiveModelPolicyFn({
            data: { expectedVersion: policy.version, idempotencyKey, policyId: policy.id, scope },
          }),
          refresh,
        )
      }
      size="2xl"
      successMessage="Model policy archived"
      title={`Archive ${policy.name}`}
    >
      {preview.body}
    </ActionDialog>
  );
}
