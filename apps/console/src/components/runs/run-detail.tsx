import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { AUTOMATION_KINDS, automationPath } from "../../automations/automation-state.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import {
  automationLabelQuery,
  runDetailQuery,
  runOutputQuery,
} from "../../data/runtime-queries.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import {
  awaitsClientResult,
  canResolveApproval,
  isRunInFlight,
  RUN_ACTIONS,
  runErrorAdvice,
  runErrorText,
  type RunAction,
} from "../../runs/run-state.ts";
import type { RunLogFilters } from "../../runs/run-logs.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { ApprovalView, AutomationRef, Run, ToolCallView } from "../../server/runtime-data.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Subheading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { DocsLink } from "../docs-link.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import {
  ApprovalDecisionDialog,
  RUN_ACTION_COPY,
  RunActionDialog,
  ToolResultDialog,
} from "./run-dialogs.tsx";
import { RunTrigger } from "./run-table.tsx";
import { ArtifactList } from "./artifact-list.tsx";
import { CallbackEvidenceDialog } from "./callback-evidence.tsx";
import { RunLogs } from "./run-logs.tsx";
import { RunTotals } from "./run-totals.tsx";
import { MessageBody } from "./thread-transcript.tsx";
import { StatusBadge } from "@/components/status-badge";

interface Decision {
  readonly approval: ApprovalView;
  readonly decision: "approved" | "rejected";
}

export function RunDetail({ runId, scope }: Readonly<{ runId: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const { data } = useSuspenseQuery(runDetailQuery(scope, runId));
  const [action, setAction] = useState<RunAction>();
  const [decision, setDecision] = useState<Decision>();
  const [answering, setAnswering] = useState<ToolCallView>();
  const [evidenceFor, setEvidenceFor] = useState<string>();
  const [logFilters, setLogFilters] = useState<RunLogFilters>({});
  const { run } = data;
  const labels = agentLabels(directory, data.releases);
  const basePath = environmentPath(scope);
  const errorText = runErrorText(run.error);
  const errorAdvice = runErrorAdvice(run.error);
  const actions = RUN_ACTIONS[run.status].filter(
    (candidate) => shell.access[RUN_ACTION_COPY[candidate].operation],
  );
  const definitionId = directory.deployments.find(
    (deployment) => deployment.id === run.agentDeploymentId,
  )?.definitionId;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={run.status} />
        {run.releaseSelection === "candidate" ? <Badge color="amber">canary</Badge> : null}
        <div className="ml-auto flex gap-3">
          {actions.map((candidate) => {
            const copy = RUN_ACTION_COPY[candidate];
            const content = (
              <>
                <Icon icon={copy.icon} />
                {copy.label}
              </>
            );
            return candidate === "cancel" ? (
              <Button variant="destructive" key={candidate} onClick={() => setAction(candidate)}>
                {content}
              </Button>
            ) : (
              <Button key={candidate} onClick={() => setAction(candidate)} variant="outline">
                {content}
              </Button>
            );
          })}
        </div>
      </div>
      {errorText ? (
        <Callout variant="destructive">
          <CalloutTitle>Run error</CalloutTitle>
          <CalloutDescription>
            {errorAdvice ? (
              <>
                <p>
                  {errorAdvice.explanation}
                  {errorAdvice.fix === "agent-configuration" && definitionId ? (
                    <>
                      {" "}
                      <TextLink href={`${basePath}/agents/${definitionId}/configuration`}>
                        Open the agent&apos;s configuration
                      </TextLink>
                      .
                    </>
                  ) : null}
                </p>
                <p>
                  Error details for support: <Code>{errorText}</Code>
                </p>
              </>
            ) : (
              errorText
            )}
          </CalloutDescription>
        </Callout>
      ) : null}
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={run.id} />
        </DescriptionDetails>
        <DescriptionTerm>Deployment</DescriptionTerm>
        <DescriptionDetails>
          {run.agentDeploymentId === undefined ? (
            "—"
          ) : definitionId ? (
            <TextLink href={`${basePath}/agents/${definitionId}/runs`}>
              {labels.deployment(run.agentDeploymentId)}
            </TextLink>
          ) : (
            <PublicId value={run.agentDeploymentId} />
          )}
        </DescriptionDetails>
        <DescriptionTerm>Release</DescriptionTerm>
        <DescriptionDetails>
          {run.agentReleaseId ? labels.release(run.agentReleaseId) : "—"}
        </DescriptionDetails>
        <DescriptionTerm>Trigger</DescriptionTerm>
        <DescriptionDetails>
          {run.automation && shell.access[AUTOMATION_KINDS[run.automation.kind].operations.get] ? (
            <Suspense fallback={run.trigger}>
              <AutomationTrigger automation={run.automation} scope={scope} trigger={run.trigger} />
            </Suspense>
          ) : (
            run.trigger
          )}
        </DescriptionDetails>
        <DescriptionTerm>Purpose</DescriptionTerm>
        <DescriptionDetails>{run.executionPurpose}</DescriptionDetails>
        <DescriptionTerm>Attempt</DescriptionTerm>
        <DescriptionDetails className="tabular-nums">{run.attempt}</DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={run.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Started</DescriptionTerm>
        <DescriptionDetails>
          {run.startedAt ? <Timestamp value={run.startedAt} /> : "—"}
        </DescriptionDetails>
        <DescriptionTerm>Completed</DescriptionTerm>
        <DescriptionDetails>
          {run.completedAt ? <Timestamp value={run.completedAt} /> : "—"}
        </DescriptionDetails>
        <DescriptionTerm>Thread</DescriptionTerm>
        <DescriptionDetails>
          <TextLink href={`${basePath}/threads/${run.threadId}?run=${run.id}`}>
            Transcript at this run
          </TextLink>
        </DescriptionDetails>
        <DescriptionTerm>Trace</DescriptionTerm>
        <DescriptionDetails>
          <TextLink href={`${basePath}/traces/${encodeURIComponent(run.traceId)}`}>
            <Code>{run.traceId}</Code>
          </TextLink>
        </DescriptionDetails>
        {run.replayedFromRunId ? (
          <>
            <DescriptionTerm>Replay of</DescriptionTerm>
            <DescriptionDetails>
              <TextLink href={`${basePath}/runs/${run.replayedFromRunId}`}>
                Run <Code>…{run.replayedFromRunId.slice(-8)}</Code>
              </TextLink>
            </DescriptionDetails>
          </>
        ) : null}
      </DescriptionList>

      {shell.access.getObservabilityRunTrace ? (
        <SectionBoundary
          fallback={<Skeleton className="h-24" />}
          resetKey={`${run.id}:${run.status}`}
        >
          <RunTotals inFlight={isRunInFlight(run.status)} runId={run.id} scope={scope} />
        </SectionBoundary>
      ) : null}

      {run.status === "completed" && shell.access.getRunMessage ? (
        <SectionBoundary fallback={<Skeleton className="h-24" />} resetKey={run.id}>
          <RunOutput run={run} scope={scope} />
        </SectionBoundary>
      ) : null}

      <section className="flex flex-col gap-4">
        <Subheading>Tool calls</Subheading>
        <ToolCallTable
          canAnswer={shell.access.resolveToolResult}
          canResolve={shell.access.resolveApproval}
          onAnswer={setAnswering}
          onDecide={setDecision}
          onEvidence={shell.access.getCallbackDispatchEvidence ? setEvidenceFor : undefined}
          onLogs={
            shell.access.listRunLogs
              ? (toolCallId) => {
                  setLogFilters((filters) => ({ ...filters, toolCallId }));
                  document.getElementById("runtime-logs")?.scrollIntoView({ block: "start" });
                }
              : undefined
          }
          run={run}
          toolCalls={data.toolCalls}
        />
        {data.toolCallsComplete ? null : (
          <Text>
            Showing the first {data.toolCalls.length} tool calls.{" "}
            <DocsLink path="/docs/api/reference/runtime/list-run-tool-calls/">
              List every tool call through the API
            </DocsLink>
          </Text>
        )}
      </section>

      {shell.access.listRunLogs ? (
        <SectionBoundary fallback={<Skeleton className="h-24" />} resetKey={run.id}>
          <RunLogs
            filters={logFilters}
            inFlight={isRunInFlight(run.status)}
            onFiltersChange={setLogFilters}
            run={run}
            scope={scope}
            toolName={
              data.toolCalls.find((toolCall) => toolCall.id === logFilters.toolCallId)?.toolName
            }
          />
        </SectionBoundary>
      ) : null}

      {shell.access.listArtifacts ? (
        <SectionBoundary fallback={<Skeleton className="h-24" />} resetKey={run.id}>
          <ArtifactList owner={{ kind: "run", runId: run.id }} scope={scope} />
        </SectionBoundary>
      ) : null}

      {evidenceFor ? (
        <CallbackEvidenceDialog
          onClose={() => setEvidenceFor(undefined)}
          scope={scope}
          toolCallId={evidenceFor}
        />
      ) : null}
      {action ? (
        <RunActionDialog
          action={action}
          onClose={() => setAction(undefined)}
          open
          run={run}
          scope={scope}
        />
      ) : null}
      {answering ? (
        <ToolResultDialog
          onClose={() => setAnswering(undefined)}
          scope={scope}
          toolCall={answering}
        />
      ) : null}
      {decision ? (
        <ApprovalDecisionDialog
          approval={decision.approval}
          decision={decision.decision}
          onClose={() => setDecision(undefined)}
          open
          scope={scope}
        />
      ) : null}
    </div>
  );
}

function AutomationTrigger({
  automation,
  scope,
  trigger,
}: Readonly<{ automation: AutomationRef; scope: EnvironmentScope; trigger: string }>) {
  const { data: label } = useSuspenseQuery(automationLabelQuery(scope, automation));
  return (
    <RunTrigger
      link={label === null ? undefined : { href: automationPath(scope, automation), label }}
      trigger={trigger}
    />
  );
}

/**
 * Scheduled and heartbeat runs keep their final message out of the thread transcript, so this is
 * the only place their output shows.
 */
function RunOutput({ run, scope }: Readonly<{ run: Run; scope: EnvironmentScope }>) {
  const { data: output } = useSuspenseQuery(runOutputQuery(scope, run));
  if (output === null) return null;
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Output</Subheading>
      <MessageBody content={output} markdown />
    </section>
  );
}

function ToolCallTable({
  canAnswer,
  canResolve,
  onAnswer,
  onDecide,
  onEvidence,
  onLogs,
  run,
  toolCalls,
}: Readonly<{
  canAnswer: boolean;
  canResolve: boolean;
  onAnswer: (toolCall: ToolCallView) => void;
  onDecide: (decision: Decision) => void;
  /** Opens the authorization record of an HTTP callback tool call. */
  onEvidence: ((toolCallId: string) => void) | undefined;
  /** Narrows the runtime logs to what one tool call wrote. */
  onLogs: ((toolCallId: string) => void) | undefined;
  run: Run;
  toolCalls: readonly ToolCallView[];
}>) {
  if (toolCalls.length === 0) {
    return <Text>This run has made no tool calls.</Text>;
  }
  return (
    <Table dense striped>
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Effect</TableHead>
          <TableHead>Policy</TableHead>
          <TableHead>Input</TableHead>
          <TableHead>Output</TableHead>
          <TableHead>Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {toolCalls.map((toolCall) => (
          <TableRow key={toolCall.id}>
            <TableCell>
              <Code>{toolCall.toolName}</Code>
              {toolCall.executionType === "client" ? (
                <Badge className="ml-2" color="sky">
                  client
                </Badge>
              ) : null}
              {onEvidence && toolCall.toolAdapterId && toolCall.executionType !== "client" ? (
                <Button className="ml-2" onClick={() => onEvidence(toolCall.id)} variant="ghost">
                  Authorization
                </Button>
              ) : null}
              {onLogs ? (
                <Button className="ml-2" onClick={() => onLogs(toolCall.id)} variant="ghost">
                  Logs
                </Button>
              ) : null}
            </TableCell>
            <TableCell>
              <StatusBadge status={toolCall.status} />
            </TableCell>
            <TableCell>{toolCall.effect}</TableCell>
            <TableCell title={toolCall.policyReason}>{toolCall.policyAction ?? "—"}</TableCell>
            <TableCell className="max-w-72 truncate" title={toolCall.inputSummary}>
              {toolCall.inputSummary}
            </TableCell>
            <TableCell className="max-w-72 truncate" title={toolCall.outputSummary}>
              {toolCall.outputSummary ?? "—"}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {canAnswer && awaitsClientResult(toolCall, run.status) ? (
                <Button onClick={() => onAnswer(toolCall)} variant="outline">
                  Submit tool result
                </Button>
              ) : (
                <ApprovalCell
                  canResolve={canResolve}
                  onDecide={onDecide}
                  runStatus={run.status}
                  toolCall={toolCall}
                />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ApprovalCell({
  canResolve,
  onDecide,
  runStatus,
  toolCall,
}: Readonly<{
  canResolve: boolean;
  onDecide: (decision: Decision) => void;
  runStatus: Run["status"];
  toolCall: ToolCallView;
}>) {
  const slot = toolCall.approval;
  if (slot === undefined) return "—";
  if (slot.kind === "unavailable") {
    return (
      <span
        className="text-sm/6 text-muted-foreground"
        title={slot.problem.detail ?? slot.problem.title}
      >
        Unavailable ({slot.problem.status})
      </span>
    );
  }
  const { approval } = slot;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge status={approval.status} />
      {approval.resolvedAt ? (
        <span className="text-xs/5 text-muted-foreground">
          <Timestamp value={approval.resolvedAt} />
          {approval.resolvedByPrincipalId ? (
            <>
              {" "}
              by <PublicId value={approval.resolvedByPrincipalId} />
            </>
          ) : null}
        </span>
      ) : null}
      {approval.status === "pending" && approval.expiresAt ? (
        <span className="text-xs/5 text-muted-foreground">
          expires <Timestamp value={approval.expiresAt} />
        </span>
      ) : null}
      {canResolve && canResolveApproval(approval, runStatus) ? (
        <>
          <Button onClick={() => onDecide({ approval, decision: "approved" })} variant="outline">
            <Icon icon={Tick02Icon} />
            Approve
          </Button>
          <Button
            variant="destructive"
            onClick={() => onDecide({ approval, decision: "rejected" })}
          >
            <Icon icon={Cancel01Icon} />
            Reject
          </Button>
        </>
      ) : null}
    </div>
  );
}
