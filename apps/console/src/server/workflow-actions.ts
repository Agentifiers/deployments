import "@tanstack/react-start/server-only";
import { WorkflowDefinitionDocumentV1 } from "@deployments-ai/api-contract";
import { Schema, SchemaIssue } from "effect";
import { PlatformApiError } from "../errors.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  approvalOutcome,
  type ApprovalDecision,
  type ApprovalOutcome,
  type ApprovalStatus,
  type ApprovalTarget,
} from "../workflows/model.ts";
import { callRoute, PlatformRequestError } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";
import { loadApproval, type Platform } from "./workflow-data.ts";

const platform: Platform = { callRoute };

interface WorkflowMutation {
  readonly accessToken: string;
  readonly scope: EnvironmentScope;
}

interface KeyedWorkflowMutation extends WorkflowMutation {
  readonly idempotencyKey: string;
}

const issueList = SchemaIssue.makeFormatterStandardSchemaV1();

function decodeDefinition(operation: string, document: unknown) {
  try {
    return Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)(document);
  } catch (cause) {
    if (!Schema.isSchemaError(cause)) throw cause;
    const problems = issueList(cause.issue).issues.map(({ message, path }) => {
      const at = (path ?? [])
        .map((segment) => String(typeof segment === "object" ? segment.key : segment))
        .join(".");
      return at === "" ? message : `${at} ${message}`;
    });
    throw new PlatformApiError(operation, {
      detail: [...new Set(problems)].join(" "),
      status: 400,
      title: "Invalid workflow definition",
    });
  }
}

export async function createDefinition(
  write: KeyedWorkflowMutation & { readonly document: unknown },
  client: Platform = platform,
) {
  const { id } = await client.callRoute(
    "createWorkflowDefinition",
    {
      body: { definition: decodeDefinition("createWorkflowDefinition", write.document) },
      idempotencyKey: write.idempotencyKey,
      scope: write.scope,
    },
    write.accessToken,
  );
  return { id };
}

export async function updateDefinition(
  write: KeyedWorkflowMutation & {
    readonly definitionId: string;
    readonly document: unknown;
    readonly expectedVersion: number;
  },
  client: Platform = platform,
) {
  const { version } = await client.callRoute(
    "updateWorkflowDefinition",
    {
      body: {
        definition: decodeDefinition("updateWorkflowDefinition", write.document),
        expectedVersion: write.expectedVersion,
      },
      idempotencyKey: write.idempotencyKey,
      path: { id: write.definitionId },
      scope: write.scope,
    },
    write.accessToken,
  );
  return { version };
}

export async function archiveDefinition(
  write: KeyedWorkflowMutation & {
    readonly definitionId: string;
    readonly expectedVersion: number;
  },
  client: Platform = platform,
) {
  const { status } = await client.callRoute(
    "archiveWorkflowDefinition",
    {
      body: { expectedVersion: write.expectedVersion },
      idempotencyKey: write.idempotencyKey,
      path: { id: write.definitionId },
      scope: write.scope,
    },
    write.accessToken,
  );
  return { status };
}

export async function publishRelease(
  write: KeyedWorkflowMutation & {
    readonly definitionId: string;
    readonly expectedDefinitionVersion: number;
  },
  client: Platform = platform,
) {
  const { id, releaseNumber } = await client.callRoute(
    "publishWorkflowRelease",
    {
      body: { expectedDefinitionVersion: write.expectedDefinitionVersion },
      idempotencyKey: write.idempotencyKey,
      path: { id: write.definitionId },
      scope: write.scope,
    },
    write.accessToken,
  );
  return { id, releaseNumber };
}

export async function archiveRelease(
  write: KeyedWorkflowMutation & { readonly expectedVersion: number; readonly releaseId: string },
  client: Platform = platform,
) {
  const { status } = await client.callRoute(
    "archiveWorkflowRelease",
    {
      body: { expectedVersion: write.expectedVersion },
      idempotencyKey: write.idempotencyKey,
      path: { id: write.releaseId },
      scope: write.scope,
    },
    write.accessToken,
  );
  return { status };
}

export async function startExecution(
  write: KeyedWorkflowMutation & { readonly input: unknown; readonly releaseId: string },
  client: Platform = platform,
) {
  const { id } = await client.callRoute(
    "startWorkflowExecution",
    {
      body: decodeRequestBody(
        "startWorkflowExecution",
        "StartWorkflowExecutionRequest",
        write.input === undefined ? {} : { input: write.input },
      ),
      idempotencyKey: write.idempotencyKey,
      path: { workflowReleaseId: write.releaseId },
      scope: write.scope,
    },
    write.accessToken,
  );
  return { id };
}

export async function cancelExecution(
  write: WorkflowMutation & { readonly executionId: string; readonly expectedVersion: number },
  client: Platform = platform,
) {
  const { status } = await client.callRoute(
    "cancelWorkflowExecution",
    {
      body: { expectedVersion: write.expectedVersion },
      path: { workflowExecutionId: write.executionId },
      scope: write.scope,
    },
    write.accessToken,
  );
  return { status };
}

export async function resolveApproval(
  write: WorkflowMutation & ApprovalTarget & { readonly decision: ApprovalDecision },
  client: Platform = platform,
): Promise<ApprovalOutcome> {
  let approval: { readonly status: ApprovalStatus };
  try {
    approval = await client.callRoute(
      "resolveWorkflowApproval",
      {
        body: { decision: write.decision },
        path: { workflowApprovalId: write.approvalId, workflowExecutionId: write.executionId },
        scope: write.scope,
      },
      write.accessToken,
    );
  } catch (error) {
    if (
      !(error instanceof PlatformApiError && error.problem.code === "workflow_execution_conflict")
    ) {
      throw error;
    }
    approval = await loadApproval(write.accessToken, write.scope, write, client);
    if (approval.status === "pending") throw error;
  }
  if (approval.status === "pending") {
    throw new PlatformRequestError("The platform left the approval pending after the decision.");
  }
  return approvalOutcome(write.decision, approval.status);
}
