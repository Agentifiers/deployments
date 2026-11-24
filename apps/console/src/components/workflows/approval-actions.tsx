import type { WorkflowExecutionResponse } from "@deployments-ai/api-contract";
import { Cancel01Icon, CheckmarkCircle02Icon, StopCircleIcon } from "@hugeicons/core-free-icons";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { cancelExecutionFn, resolveApprovalFn } from "../../data/workflow-mutations.ts";
import { approvalQuery, invalidateWorkflows, settleApproval } from "../../data/workflow-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Text } from "@/components/ui/text";
import {
  describeApprovalOutcome,
  type ApprovalDecision,
  type ApprovalTarget,
} from "../../workflows/model.ts";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { describeProblem } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

function ApprovalDecisionDialog({
  decision,
  onClose,
  onSettled,
  open,
  scope,
  target,
}: Readonly<{
  decision: ApprovalDecision;
  onClose: () => void;
  onSettled: () => void;
  open: boolean;
  scope: EnvironmentScope;
  target: ApprovalTarget;
}>) {
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const approval = useQuery({ ...approvalQuery(scope, target), enabled: open });
  const approve = decision === "approved";
  const closed =
    approval.data !== undefined && approval.data.status !== "pending" ? approval.data : undefined;
  return (
    <ActionDialog
      confirmLabel={approve ? "Approve" : "Reject"}
      confirmation={typedConfirmation(environment.type, {
        destructive: !approve,
        phrase: approve ? "approve" : "reject",
      })}
      description="The execution continues on the step's approved or rejected path. The console cannot show who started the execution, because the API does not return it."
      destructive={!approve}
      invalid={approval.data?.status !== "pending"}
      onClose={() => {
        if (closed) onSettled();
        onClose();
      }}
      onSuccess={onSettled}
      open={open}
      runOnce={() => resolveApprovalFn({ data: { ...target, decision, scope } })}
      successMessage={(outcome) =>
        outcome.kind === "applied"
          ? describeApprovalOutcome(outcome)
          : { neutral: describeApprovalOutcome(outcome) }
      }
      title={approve ? "Approve this step?" : "Reject this step?"}
    >
      {approval.isPending ? <Text>Reading the approval…</Text> : null}
      {approval.error ? (
        <Text>{describeProblem(approval.error, "Could not read the approval").title}</Text>
      ) : null}
      {approval.data ? (
        <DescriptionList>
          <DescriptionTerm>Prompt</DescriptionTerm>
          <DescriptionDetails className="break-words">{approval.data.prompt}</DescriptionDetails>
          <DescriptionTerm>Status</DescriptionTerm>
          <DescriptionDetails>
            <StatusBadge status={approval.data.status} />
          </DescriptionDetails>
          <DescriptionTerm>Requested</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={approval.data.createdAt} />
          </DescriptionDetails>
          <DescriptionTerm>Expires</DescriptionTerm>
          <DescriptionDetails>
            {approval.data.expiresAt ? (
              <Timestamp value={approval.data.expiresAt} />
            ) : (
              "No deadline"
            )}
          </DescriptionDetails>
        </DescriptionList>
      ) : null}
      {closed ? (
        <Text>
          {closed.status === "expired"
            ? "This approval expired before anyone decided. There is nothing left to decide."
            : `This approval is already ${closed.status}. There is nothing left to decide.`}
        </Text>
      ) : null}
    </ActionDialog>
  );
}

export function ApprovalButtons({
  onOpenChange,
  onSettled,
  scope,
  target,
}: Readonly<{
  onOpenChange?: (open: boolean) => void;
  onSettled?: () => void;
  scope: EnvironmentScope;
  target: ApprovalTarget;
}>) {
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<ApprovalDecision>("approved");
  const [open, setOpen] = useState(false);
  const toggle = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  const decide = (next: ApprovalDecision) => {
    setDecision(next);
    toggle(true);
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => decide("approved")} variant="outline">
        <Icon icon={CheckmarkCircle02Icon} />
        Approve
      </Button>
      <Button onClick={() => decide("rejected")} variant="outline">
        <Icon icon={Cancel01Icon} />
        Reject
      </Button>
      <ApprovalDecisionDialog
        decision={decision}
        onClose={() => toggle(false)}
        onSettled={() => {
          void settleApproval(queryClient, scope, target.approvalId);
          onSettled?.();
        }}
        open={open}
        scope={scope}
        target={target}
      />
    </div>
  );
}

export function CancelExecutionAction({
  execution,
  scope,
}: Readonly<{ execution: WorkflowExecutionResponse; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const refresh = () => invalidateWorkflows(queryClient, scope);
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        <Icon icon={StopCircleIcon} />
        Cancel execution
      </Button>
      <ActionDialog
        confirmLabel="Cancel execution"
        confirmation="cancel"
        description="The workflow stops advancing and ends as canceled, and a pending approval on it closes as canceled. An agent run or tool call it already started can still finish, and the workflow ignores its result. Stop a run from its run page."
        destructive
        onClose={() => setOpen(false)}
        onSuccess={() => void refresh()}
        open={open}
        runOnce={() =>
          refreshOnConflict(
            cancelExecutionFn({
              data: { executionId: execution.id, expectedVersion: execution.version, scope },
            }),
            refresh,
          )
        }
        successMessage="Cancel requested"
        title="Cancel this execution?"
      />
    </>
  );
}
