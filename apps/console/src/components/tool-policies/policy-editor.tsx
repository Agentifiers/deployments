import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useReducer, useState, type ReactNode } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { createToolPolicyFn, updateToolPolicyFn } from "../../data/tool-policy-mutations.ts";
import {
  invalidateToolPolicies,
  policyPinsQuery,
  policyQuery,
} from "../../data/tool-policy-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import {
  policyActions,
  policyPinning,
  type ToolPolicyView,
} from "../../tool-policies/policy-state.ts";
import {
  fromPolicy,
  policyEditor,
  ruleFindings,
  toRequest,
  toUpdateRequest,
  type DraftIssue,
  type DraftResult,
  type PolicyDraft,
} from "../../tool-policies/rules-editor.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Text, TextLink } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { PinningNotice } from "./pinned-by.tsx";
import { PolicyFields } from "./rules-editor.tsx";

/** What stops the save. An empty name is not highlighted, so the message names it instead. */
function blockedMessage(draft: PolicyDraft, issues: readonly DraftIssue[]): string {
  const nameMissing = draft.name.trim() === "" && issues.some((issue) => issue.field === "name");
  if (!nameMissing) return "Fix the highlighted fields to save.";
  return issues.some((issue) => issue.field !== "name")
    ? "Enter a name and fix the highlighted fields to save."
    : "Enter a name to save.";
}

function PolicyForm<Request>({
  build,
  initial,
  notice,
  save,
}: Readonly<{
  build: (draft: PolicyDraft) => DraftResult<Request>;
  initial: PolicyDraft;
  notice?: ReactNode;
  save: (request: Request) => ReactNode;
}>) {
  const [draft, dispatch] = useReducer(policyEditor, initial);
  const result = useMemo(() => build(draft), [build, draft]);
  const findings = useMemo(() => ruleFindings(draft), [draft]);
  return (
    <div className="flex flex-col gap-8">
      {notice}
      <PolicyFields
        dispatch={dispatch}
        draft={draft}
        findings={findings}
        issues={result.ok ? [] : result.issues}
      />
      <div className="flex flex-wrap items-center gap-3">
        {findings.size > 0 ? (
          <Text>
            {findings.size === 1 ? "1 rule is" : `${findings.size} rules are`} never reached. You
            can still save.
          </Text>
        ) : null}
        {result.ok ? null : <Text>{blockedMessage(draft, result.issues)}</Text>}
        <div className="ml-auto">
          {result.ok ? save(result.request) : <Button disabled>Save</Button>}
        </div>
      </div>
    </div>
  );
}

function SaveButton({
  children,
}: Readonly<{ children: (open: boolean, close: () => void) => ReactNode }>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Save</Button>
      {children(open, () => setOpen(false))}
    </>
  );
}

function usePolicyPath(scope: EnvironmentScope) {
  const navigate = useNavigate();
  return (policy: ToolPolicyView) =>
    void navigate({
      params: {
        envId: scope.environmentId,
        orgId: scope.organizationId,
        policyId: policy.id,
        projectId: scope.projectId,
      },
      to: "/o/$orgId/p/$projectId/e/$envId/tool-policies/$policyId",
    });
}

export function CreatePolicy({
  initial,
  scope,
}: Readonly<{ initial: PolicyDraft; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const openPolicy = usePolicyPath(scope);
  return (
    <PolicyForm
      build={toRequest}
      initial={initial}
      save={(request) => (
        <SaveButton>
          {(open, close) => (
            <ActionDialog<ToolPolicyView>
              confirmLabel="Create policy"
              confirmation={typedConfirmation(environment.type, { phrase: request.name })}
              description="The policy applies to a tool once a deployment pins it to that tool's binding."
              onClose={close}
              onSuccess={(policy) => {
                void invalidateToolPolicies(queryClient, scope);
                openPolicy(policy);
              }}
              open={open}
              run={(idempotencyKey) =>
                createToolPolicyFn({ data: { body: request, idempotencyKey, scope } })
              }
              successMessage="Tool policy created"
              title={`Create ${request.name}`}
            >
              <Text>
                {request.policy.rules.length === 1
                  ? "1 rule."
                  : `${request.policy.rules.length} rules.`}
              </Text>
            </ActionDialog>
          )}
        </SaveButton>
      )}
    />
  );
}

export function EditPolicy({
  pinsVisible,
  policyId,
  scope,
}: Readonly<{ pinsVisible: boolean; policyId: string; scope: EnvironmentScope }>) {
  const { data: latest } = useSuspenseQuery(policyQuery(scope, policyId));
  if (!policyActions(latest).includes("edit")) {
    return (
      <Text>
        This policy is {latest.status}, and only an active policy can be edited.{" "}
        <TextLink href={`${environmentPath(scope)}/tool-policies/${policyId}`}>
          Open the policy
        </TextLink>{" "}
        to duplicate it instead.
      </Text>
    );
  }
  return <ActivePolicyEditor latest={latest} pinsVisible={pinsVisible} scope={scope} />;
}

function ActivePolicyEditor({
  latest,
  pinsVisible,
  scope,
}: Readonly<{ latest: ToolPolicyView; pinsVisible: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: pins } = useQuery({ ...policyPinsQuery(scope), enabled: pinsVisible });
  const [base, setBase] = useState(latest);
  const openPolicy = usePolicyPath(scope);
  const pinning = policyPinning(latest.id, pins);
  const stale = latest.version !== base.version;
  const build = useCallback((draft: PolicyDraft) => toUpdateRequest(draft, base), [base]);
  return (
    <PolicyForm
      build={build}
      initial={fromPolicy(base)}
      key={base.version}
      notice={
        stale ? (
          <Callout variant="destructive">
            <CalloutTitle>This policy changed after you started editing</CalloutTitle>
            <CalloutDescription>
              <p>
                Someone saved version {latest.version}. Saving now would fail. Load it to start over
                from the latest rules; your changes on this page are discarded.
              </p>
              <div className="mt-3">
                <Button onClick={() => setBase(latest)} variant="outline">
                  Load version {latest.version}
                </Button>
              </div>
            </CalloutDescription>
          </Callout>
        ) : null
      }
      save={(request) => (
        <SaveButton>
          {(open, close) => (
            <ActionDialog<ToolPolicyView>
              confirmLabel="Save policy"
              confirmation={typedConfirmation(environment.type, {
                destructive: pinning.atRisk,
                phrase: request.name,
              })}
              description={`Saves version ${base.version + 1}. Live deployments that pin this policy decide their next tool call with the new rules.`}
              onClose={close}
              onSuccess={(policy) => {
                void invalidateToolPolicies(queryClient, scope);
                openPolicy(policy);
              }}
              open={open}
              run={(idempotencyKey) =>
                refreshOnConflict(
                  updateToolPolicyFn({
                    data: { body: request, idempotencyKey, policyId: latest.id, scope },
                  }),
                  () => invalidateToolPolicies(queryClient, scope),
                )
              }
              size="2xl"
              successMessage="Tool policy saved"
              title={`Save ${request.name}`}
            >
              <PinningNotice pinning={pinning} scope={scope}>
                Pinned by these live deployments:
              </PinningNotice>
            </ActionDialog>
          )}
        </SaveButton>
      )}
    />
  );
}
