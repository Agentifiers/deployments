import { RepeatIcon, Rotate01Icon, StopCircleIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ConsoleOperation } from "../../access.ts";
import { environmentQuery } from "../../data/console-queries.ts";
import {
  cancelRunFn,
  replayRunFn,
  resolveApprovalFn,
  retryRunFn,
} from "../../data/runtime-mutations.ts";
import { resolveClientToolCallFn } from "../../data/chat-mutations.ts";
import { invalidateRuntime } from "../../data/runtime-queries.ts";
import type { PlatformProblem } from "../../errors.ts";
import { parseToolOutput, type RunAction } from "../../runs/run-state.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { ApprovalResolution } from "../../server/runtime-actions.ts";
import type { ApprovalView, Run, ToolCallView } from "../../server/runtime-data.ts";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Code } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { BudgetRefusalLink } from "../budgets/budget-refusal.tsx";
import { ApprovalDestinations } from "./approval-inbox.tsx";

const INPUT_FILES_NOTE =
  "Only the person or service account that submitted a run with input files can retry or replay it.";

export const RUN_ACTION_COPY: Readonly<
  Record<
    RunAction,
    {
      readonly confirmLabel: string;
      readonly description: string;
      readonly icon: IconSvgElement;
      readonly label: string;
      readonly operation: ConsoleOperation;
      readonly successMessage: string;
      readonly title: string;
    }
  >
> = {
  cancel: {
    confirmLabel: "Cancel run",
    description:
      "The run stops and cannot be resumed. If it is waiting for an approval, the approval is rejected.",
    icon: StopCircleIcon,
    label: "Cancel",
    operation: "cancelRun",
    successMessage: "Run canceled",
    title: "Cancel this run?",
  },
  replay: {
    confirmLabel: "Replay run",
    description: `Starts a new run on the same thread with this run's prompt; its tools run again. ${INPUT_FILES_NOTE}`,
    icon: RepeatIcon,
    label: "Replay",
    operation: "replayRun",
    successMessage: "Replay started",
    title: "Replay this run?",
  },
  retry: {
    confirmLabel: "Retry run",
    description: `Runs this failed run again as its next attempt; its tools run again. ${INPUT_FILES_NOTE}`,
    icon: Rotate01Icon,
    label: "Retry",
    operation: "retryRun",
    successMessage: "Retry queued",
    title: "Retry this run?",
  },
};

const RESOLUTION_MESSAGES: Readonly<Record<ApprovalResolution["decision"], string>> = {
  approved: "Approved; the run resumes",
  expired: "The approval had expired, so the run failed",
  rejected: "Rejected; the run failed",
};

export function RunActionDialog({
  action,
  onClose,
  open,
  run,
  scope,
}: Readonly<{
  action: RunAction;
  onClose: () => void;
  open: boolean;
  run: Run;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const copy = RUN_ACTION_COPY[action];
  const refresh = () => invalidateRuntime(queryClient, scope);
  const dialog = {
    confirmLabel: copy.confirmLabel,
    confirmation: typedConfirmation(environment.type, {
      destructive: true,
      phrase: run.id.slice(-8),
    }),
    description: copy.description,
    destructive: action === "cancel",
    onClose,
    open,
    problemAction: (problem: PlatformProblem) => (
      <BudgetRefusalLink problem={problem} scope={scope} />
    ),
    successMessage: copy.successMessage,
    title: copy.title,
  };
  if (action === "replay") {
    return (
      <ActionDialog
        {...dialog}
        onSuccess={(replay: Run) => {
          void refresh();
          void navigate({
            params: {
              envId: scope.environmentId,
              orgId: scope.organizationId,
              projectId: scope.projectId,
              runId: replay.id,
            },
            to: "/o/$orgId/p/$projectId/e/$envId/runs/$runId",
          });
        }}
        run={(idempotencyKey) =>
          refreshOnConflict(
            replayRunFn({ data: { idempotencyKey, runId: run.id, scope } }),
            refresh,
          )
        }
      />
    );
  }
  const mutation = action === "cancel" ? cancelRunFn : retryRunFn;
  return (
    <ActionDialog
      {...dialog}
      onSuccess={() => void refresh()}
      runOnce={() => refreshOnConflict(mutation({ data: { runId: run.id, scope } }), refresh)}
    />
  );
}

export function ApprovalDecisionDialog({
  approval,
  decision,
  onClose,
  open,
  scope,
}: Readonly<{
  approval: ApprovalView;
  decision: "approved" | "rejected";
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const refresh = () => invalidateRuntime(queryClient, scope);
  const approve = decision === "approved";
  const { destinations, effect, inputSummary, requiredScopes, toolName } = approval.request;
  return (
    <ActionDialog
      confirmLabel={approve ? "Approve" : "Reject"}
      confirmation={typedConfirmation(environment.type, {
        destructive: !approve,
        phrase: approve ? "approve" : "reject",
      })}
      description={
        approve
          ? "The run resumes and executes this tool call."
          : "The tool call does not run, and the run fails."
      }
      destructive={!approve}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={open}
      runOnce={() =>
        refreshOnConflict(
          resolveApprovalFn({
            data: { approvalId: approval.id, decision, runId: approval.runId, scope },
          }),
          refresh,
        )
      }
      successMessage={(resolution) => RESOLUTION_MESSAGES[resolution.decision]}
      title={`${approve ? "Approve" : "Reject"} ${toolName ?? "this tool call"}?`}
    >
      <DescriptionList>
        <DescriptionTerm>Tool</DescriptionTerm>
        <DescriptionDetails>{toolName ? <Code>{toolName}</Code> : "—"}</DescriptionDetails>
        <DescriptionTerm>Effect</DescriptionTerm>
        <DescriptionDetails>{effect ?? "—"}</DescriptionDetails>
        <DescriptionTerm>Input</DescriptionTerm>
        <DescriptionDetails className="break-words">{inputSummary ?? "—"}</DescriptionDetails>
        {destinations.length > 0 ? (
          <>
            <DescriptionTerm>Destinations</DescriptionTerm>
            <DescriptionDetails>
              <ApprovalDestinations destinations={destinations} />
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Required scopes</DescriptionTerm>
        <DescriptionDetails>{requiredScopes.join(", ") || "—"}</DescriptionDetails>
      </DescriptionList>
    </ActionDialog>
  );
}

const TOOL_OUTCOMES = ["completed", "failed"] as const;
type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

/** Answers a client-executed tool call the run waits on, with JSON output, so the run resumes. */
export function ToolResultDialog({
  onClose,
  scope,
  toolCall,
}: Readonly<{ onClose: () => void; scope: EnvironmentScope; toolCall: ToolCallView }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [outcome, setOutcome] = useState<ToolOutcome>("completed");
  const [outputText, setOutputText] = useState("");
  const [summary, setSummary] = useState("");
  useEffect(() => {
    setOutcome("completed");
    setOutputText("");
    setSummary("");
  }, [toolCall.id]);
  const output = parseToolOutput(outputText, outcome);
  const refresh = () => invalidateRuntime(queryClient, scope);
  return (
    <ActionDialog
      confirmLabel="Submit result"
      confirmation={typedConfirmation(environment.type, { phrase: toolCall.toolName })}
      description="The run resumes with this result as the tool's answer."
      invalid={!output.ok}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open
      runOnce={() => {
        if (!output.ok) throw new TypeError(output.message);
        return refreshOnConflict(
          resolveClientToolCallFn({
            data: {
              outcome,
              runId: toolCall.runId,
              scope,
              toolCallId: toolCall.id,
              ...(output.value === undefined ? {} : { output: output.value }),
              ...(summary.trim() === "" ? {} : { outputSummary: summary.trim() }),
            },
          }),
          refresh,
        );
      }}
      size="xl"
      successMessage={(result) => `Tool result submitted; the run is ${result.runStatus}`}
      title={`Submit a result for ${toolCall.toolName}`}
    >
      <DescriptionList>
        <DescriptionTerm>Tool</DescriptionTerm>
        <DescriptionDetails>
          <Code>{toolCall.toolName}</Code>
        </DescriptionDetails>
        <DescriptionTerm>Input</DescriptionTerm>
        <DescriptionDetails className="break-words">{toolCall.inputSummary}</DescriptionDetails>
      </DescriptionList>
      <Field>
        <Label>Outcome</Label>
        <NativeSelect
          name="outcome"
          onChange={(event) => setOutcome(event.target.value as ToolOutcome)}
          value={outcome}
        >
          {TOOL_OUTCOMES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <Label>Output (JSON object)</Label>
        <Description>
          {outcome === "completed"
            ? "Required. The model reads this as the tool's result."
            : "Optional for a failed call."}
        </Description>
        <Textarea
          aria-invalid={!output.ok}
          className="font-mono"
          name="output"
          onChange={(event) => setOutputText(event.target.value)}
          rows={6}
          value={outputText}
        />
        {output.ok || outputText.trim() === "" ? null : (
          <ErrorMessage>{output.message}</ErrorMessage>
        )}
      </Field>
      <Field>
        <Label>Summary (optional)</Label>
        <Textarea
          maxLength={1_000}
          name="summary"
          onChange={(event) => setSummary(event.target.value)}
          rows={2}
          value={summary}
        />
      </Field>
    </ActionDialog>
  );
}
