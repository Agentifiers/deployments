import type { WorkflowStepAttemptResponse } from "@deployments-ai/api-contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { executionDetailQuery, releaseQuery } from "../../data/workflow-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CodeBlock } from "@/components/reui/code-block/code-block";
import { Code, Text, TextLink } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { ResourceLink } from "../resource-link.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { ApprovalButtons, CancelExecutionAction } from "./approval-actions.tsx";
import {
  approvalPanel,
  approvalPrompt,
  CANCELABLE,
  EXECUTION_PHASE,
  pendingStepOf,
  type PendingStep,
} from "../../workflows/model.ts";
import { StatusBadge } from "@/components/status-badge";

function AttemptReference({
  attempt,
  scope,
}: Readonly<{ attempt: WorkflowStepAttemptResponse; scope: EnvironmentScope }>) {
  if (attempt.childRunId) {
    return (
      <TextLink href={`${environmentPath(scope)}/runs/${attempt.childRunId}`}>
        Run <Code>…{attempt.childRunId.slice(-8)}</Code>
      </TextLink>
    );
  }
  if (attempt.approvalId)
    return (
      <>
        Approval <PublicId value={attempt.approvalId} />
      </>
    );
  if (attempt.toolCallId)
    return (
      <>
        Tool call <PublicId value={attempt.toolCallId} />
      </>
    );
  if (attempt.deliveryId)
    return (
      <>
        Delivery <PublicId value={attempt.deliveryId} />
      </>
    );
  return "—";
}

function StepAttempts({
  attempts,
  complete,
  scope,
}: Readonly<{
  attempts: readonly WorkflowStepAttemptResponse[];
  complete: boolean;
  scope: EnvironmentScope;
}>) {
  if (attempts.length === 0) return <Text>No step has started yet.</Text>;
  return (
    <div className="flex flex-col gap-4">
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Step</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Attempt</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Completed</TableHead>
            <TableHead>Data</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {attempts.map((attempt) => (
            <TableRow key={attempt.id}>
              <TableCell>
                <Code>{attempt.stepId}</Code>
              </TableCell>
              <TableCell>{attempt.stepType}</TableCell>
              <TableCell>{attempt.attempt}</TableCell>
              <TableCell>
                <StatusBadge status={attempt.status} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <AttemptReference attempt={attempt} scope={scope} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {attempt.startedAt ? <Timestamp value={attempt.startedAt} /> : "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {attempt.completedAt ? <Timestamp value={attempt.completedAt} /> : "—"}
              </TableCell>
              <TableCell>
                <details>
                  <summary className="cursor-pointer text-sm/6">
                    {attempt.error !== undefined
                      ? "Input and error"
                      : attempt.output === undefined
                        ? "Input"
                        : "Input and output"}
                  </summary>
                  <CodeBlock
                    code={JSON.stringify(
                      {
                        input: attempt.input,
                        ...(attempt.output === undefined ? {} : { output: attempt.output }),
                        ...(attempt.error === undefined ? {} : { error: attempt.error }),
                      },
                      null,
                      2,
                    )}
                    className="mt-2"
                    label={`Step ${attempt.stepId} attempt ${attempt.attempt}`}
                    language="json"
                    maxLines={15}
                  />
                </details>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {complete ? null : (
        <Text>
          Shows the first {attempts.length} step attempts, oldest first. Later attempts are not
          loaded, so the current step may be missing.
        </Text>
      )}
    </div>
  );
}

function ReleasePrompt({
  releaseId,
  scope,
  stepId,
}: Readonly<{ releaseId: string; scope: EnvironmentScope; stepId: string }>) {
  const release = useSuspenseQuery(releaseQuery(scope, releaseId)).data;
  return approvalPrompt(release.definition, stepId) ?? "—";
}

export function ExecutionDetail({
  executionId,
  scope,
}: Readonly<{ executionId: string; scope: EnvironmentScope }>) {
  const { attempts, execution } = useSuspenseQuery(executionDetailQuery(scope, executionId)).data;
  const { access } = useSuspenseQuery(organizationShellQuery(scope.organizationId)).data;
  const [held, setHeld] = useState<PendingStep>();
  const [settledApprovalId, setSettledApprovalId] = useState<string>();
  const { settling, target } = approvalPanel({
    held,
    settledApprovalId,
    waiting: pendingStepOf(execution, attempts.items),
  });
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>Execution …{execution.id.slice(-8)}</Heading>
        <StatusBadge status={execution.status} />
        {access.cancelWorkflowExecution &&
        CANCELABLE[EXECUTION_PHASE[execution.status]] &&
        !settling ? (
          <div className="ml-auto">
            <CancelExecutionAction execution={execution} scope={scope} />
          </div>
        ) : null}
      </div>
      {target ? (
        <section className="flex flex-col gap-4 rounded-lg border border-amber-500/40 p-4">
          <Subheading>Waiting for approval</Subheading>
          <DescriptionList>
            <DescriptionTerm>Step</DescriptionTerm>
            <DescriptionDetails>
              <Code>{target.stepId}</Code>
            </DescriptionDetails>
            <DescriptionTerm>Prompt</DescriptionTerm>
            <DescriptionDetails className="break-words">
              <SectionBoundary resetKey={execution.workflowReleaseId}>
                <ReleasePrompt
                  releaseId={execution.workflowReleaseId}
                  scope={scope}
                  stepId={target.stepId}
                />
              </SectionBoundary>
            </DescriptionDetails>
            <DescriptionTerm>Waiting since</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={target.waitingSince} />
            </DescriptionDetails>
          </DescriptionList>
          {access.resolveWorkflowApproval ? (
            <ApprovalButtons
              onOpenChange={(open) => setHeld(open ? target : undefined)}
              onSettled={() => setSettledApprovalId(target.approvalId)}
              scope={scope}
              target={target}
            />
          ) : null}
        </section>
      ) : null}
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={execution.id} />
        </DescriptionDetails>
        <DescriptionTerm>Workflow</DescriptionTerm>
        <DescriptionDetails>
          <ResourceLink
            scope={scope}
            to={{ definitionId: execution.workflowDefinitionId, kind: "workflowDefinition" }}
          >
            <Code>…{execution.workflowDefinitionId.slice(-8)}</Code>
          </ResourceLink>
        </DescriptionDetails>
        <DescriptionTerm>Release</DescriptionTerm>
        <DescriptionDetails>
          <ResourceLink
            scope={scope}
            to={{ kind: "workflowRelease", releaseId: execution.workflowReleaseId }}
          >
            #{execution.workflowReleaseNumber}
          </ResourceLink>
        </DescriptionDetails>
        <DescriptionTerm>Current step</DescriptionTerm>
        <DescriptionDetails>
          {execution.currentStepId ? <Code>{execution.currentStepId}</Code> : "—"}
        </DescriptionDetails>
        <DescriptionTerm>Workspace</DescriptionTerm>
        <DescriptionDetails>
          {execution.workspaceId ? <PublicId value={execution.workspaceId} /> : "Environment-wide"}
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={execution.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Started</DescriptionTerm>
        <DescriptionDetails>
          {execution.startedAt ? <Timestamp value={execution.startedAt} /> : "—"}
        </DescriptionDetails>
        <DescriptionTerm>Completed</DescriptionTerm>
        <DescriptionDetails>
          {execution.completedAt ? <Timestamp value={execution.completedAt} /> : "—"}
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <Subheading>Step attempts</Subheading>
        <StepAttempts attempts={attempts.items} complete={attempts.complete} scope={scope} />
      </section>
      <section className="flex flex-col gap-4">
        <Subheading>Input</Subheading>
        <CodeBlock
          code={JSON.stringify(execution.input, null, 2)}
          label="Input"
          language="json"
          maxLines={15}
        />
      </section>
      {execution.output === undefined ? null : (
        <section className="flex flex-col gap-4">
          <Subheading>Output</Subheading>
          <CodeBlock
            code={JSON.stringify(execution.output, null, 2)}
            label="Output"
            language="json"
            maxLines={15}
          />
        </section>
      )}
      {execution.error === undefined ? null : (
        <section className="flex flex-col gap-4">
          <Subheading>Error</Subheading>
          <CodeBlock
            code={JSON.stringify(execution.error, null, 2)}
            label="Error"
            language="json"
            maxLines={15}
          />
        </section>
      )}
    </div>
  );
}
