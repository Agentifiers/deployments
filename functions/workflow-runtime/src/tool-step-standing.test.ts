import { describe, expect, test } from "bun:test";
import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  dataBoundaryOf,
  OrganizationDataBoundary,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { organizationHolds } from "@deployments-ai/organization-admission/testing";
import {
  createRuntimeToolService,
  ToolOutsideDataBoundaryError,
  type AgentRunWorkerDependencies,
} from "@deployments-ai/worker";
import { Schema } from "effect";
import { createWorkflowRuntimeDependencies } from "./runtime-composition.ts";
import type { WorkflowStepDispatchContext } from "./types.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ENV = {
  DEPLOYMENTS_AI_AUTOMATION_FAILURE_QUEUE_ARN: "arn:aws:sqs:us-east-1:000000000000:failures",
  DEPLOYMENTS_AI_SCHEDULER_GROUP: "workflow-approvals",
  DEPLOYMENTS_AI_SCHEDULER_ROLE_ARN: "arn:aws:iam::000000000000:role/scheduler",
  DEPLOYMENTS_AI_WORKFLOW_APPROVAL_TIMEOUT_LAMBDA_ARN:
    "arn:aws:lambda:us-east-1:000000000000:function:approval-timeout",
};

const toolStep = {
  action: {
    agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
    input: {},
    kind: "dispatch-tool",
    toolName: "lookup",
  },
  execution: {
    data: {
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
      organizationId: ORGANIZATION_ID,
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
    },
  },
  idempotencyKey: "workflow-step",
  stepAttempt: { data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FB4", stepId: "lookup" } },
} as unknown as WorkflowStepDispatchContext;

describe("workflow tool steps of a suspended organization", () => {
  test("fail with organization_suspended and dispatch again after release", async () => {
    const memory = evaluationMemoryDatabase([]);
    const unreachable = async () => {
      throw new Error("A refused tool step must not reach the agent runtime.");
    };
    const dependencies = await createWorkflowRuntimeDependencies(ENV, {
      database: memory.database,
      enqueueRun: unreachable,
      generateId: async () => "01ARZ3NDEKTSV4RRFFQ69G5FB5" as Ulid,
      runtime: {
        authorizeToolCall: unreachable,
        executeToolCall: unreachable,
        resolveToolDefinition: unreachable,
      },
    } as unknown as Pick<
      AgentRunWorkerDependencies,
      "database" | "enqueueRun" | "generateId" | "runtime"
    >);
    const holds = organizationHolds(memory.database, ORGANIZATION_ID);

    await holds.hold("payment");
    const held = await dependencies.dispatchStep(toolStep);
    await holds.release("payment");

    expect(held).toEqual({
      error: { code: "organization_suspended", message: "The organization is suspended." },
      state: "failed",
    });
    expect(dependencies.dispatchStep(toolStep)).rejects.toThrow(
      "Workflow tool deployment was not found.",
    );
  });
});

const PHI_BOUNDARY = dataBoundaryOf(
  Schema.decodeUnknownSync(OrganizationDataBoundary)({
    operatorNote: "BAA-2026-17",
    profile: "phi",
    setAt: "2026-11-01T00:00:00.000Z",
    setBy: { kind: "operator", principalId: "01ARZ3NDEKTSV4RRFFQ69G5FB9" },
  }),
);

/** A ready deployment whose pinned release declares `toolName`. */
function pinnedTool(toolName: string) {
  const timestamp = "2026-11-01T00:00:00.000Z";
  const { environmentId, projectId } = toolStep.execution.data;
  const agentDefinitionId = "01ARZ3NDEKTSV4RRFFQ69G5FB6" as Ulid;
  const agentReleaseId = "01ARZ3NDEKTSV4RRFFQ69G5FB7" as Ulid;
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "workflow.lookup", name: "Lookup", version: "1.0.0" },
    spec: {
      capabilities: { tools: [{ name: toolName, required: false, requiredScopes: [] }] },
      instructions: "Look things up.",
      memory: { mode: "off" },
      model: { fallbackIds: [], id: "bedrock/anthropic.claude-sonnet-4" },
      sandbox: { mode: "none" },
      skills: [],
    },
  });
  const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId,
        contentHash: agentManifestContentHash(manifest),
        createdAt: timestamp,
        createdByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FB8",
        environmentId,
        id: agentReleaseId,
        manifest,
        organizationId: ORGANIZATION_ID,
        projectId,
        releaseNumber: 1,
        status: "active",
        version: 0,
      },
      itemType: "agent-release" as const,
    }),
  );
  const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId,
        agentReleaseId,
        createdAt: timestamp,
        currentState: "ready",
        desiredState: "running",
        environmentId,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        organizationId: ORGANIZATION_ID,
        projectId,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
  return [release, deployment];
}

describe("workflow tool steps outside the organization's data boundary", () => {
  test("fail with tool_outside_data_boundary before authorization", async () => {
    const refusal = new ToolOutsideDataBoundaryError({
      boundary: PHI_BOUNDARY,
      egress: "public",
      kind: "outside-boundary",
      toolName: "lookup",
    });
    const unreachable = async () => {
      throw new Error("A tool outside the data boundary must not be authorized or executed.");
    };
    const dependencies = await createWorkflowRuntimeDependencies(ENV, {
      database: evaluationMemoryDatabase(pinnedTool("lookup")).database,
      enqueueRun: unreachable,
      generateId: async () => "01ARZ3NDEKTSV4RRFFQ69G5FB5" as Ulid,
      runtime: {
        authorizeToolCall: unreachable,
        executeToolCall: unreachable,
        resolveToolDefinition: async () => {
          throw refusal;
        },
      },
    } as unknown as Pick<
      AgentRunWorkerDependencies,
      "database" | "enqueueRun" | "generateId" | "runtime"
    >);

    expect(await dependencies.dispatchStep(toolStep)).toEqual({
      error: { code: "tool_outside_data_boundary", message: refusal.message },
      state: "failed",
    });
  });
});

describe("workflow web.scrape steps in a phi organization", () => {
  const APPROVAL_STEP_ID = "approve";
  const APPROVAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC0";

  async function dispatch(url: string) {
    const scraped: unknown[] = [];
    let nextId = 0;
    const runtime = createRuntimeToolService({
      builtinExecutors: {
        "web.scrape": async (request) => {
          scraped.push(request.input);
          return { outputSummary: "Scraped.", status: "completed" };
        },
      },
      dataBoundaries: { read: async () => PHI_BOUNDARY },
      egressAllowlists: { read: async () => [{ origin: "https://claims.example.com" }] },
      generateId: async () => `01ARZ3NDEKTSV4RRFFQ69G5FD${nextId++}` as Ulid,
      resolveAuthorizationContext: async () => undefined,
      resolveProviderCredential: async () => {
        throw new Error("Built-ins never load provider credentials.");
      },
    });
    const dependencies = await createWorkflowRuntimeDependencies(ENV, {
      database: evaluationMemoryDatabase(pinnedTool("web.scrape")).database,
      enqueueRun: async () => {
        throw new Error("A tool step does not enqueue runs.");
      },
      generateId: async () => "01ARZ3NDEKTSV4RRFFQ69G5FB5" as Ulid,
      runtime,
    } as unknown as Pick<
      AgentRunWorkerDependencies,
      "database" | "enqueueRun" | "generateId" | "runtime"
    >);
    // The step is linked to an approved workflow approval step, which must not stand in for an
    // approval of the destination.
    const step = {
      ...toolStep,
      action: {
        ...toolStep.action,
        approvalStepId: APPROVAL_STEP_ID,
        input: { url },
        toolName: "web.scrape",
      },
      execution: {
        data: {
          ...toolStep.execution.data,
          context: {
            approvalEvidenceByStep: { [APPROVAL_STEP_ID]: APPROVAL_ID },
            stepOutputs: { [APPROVAL_STEP_ID]: { outcome: "approved" } },
          },
        },
      },
    } as unknown as WorkflowStepDispatchContext;
    return { result: await dependencies.dispatchStep(step), scraped };
  }

  test("fail an unlisted URL with tool_outside_data_boundary despite an approved step", async () => {
    const url = "https://labs.example.org/results?patient=Jane%20Doe";

    const { result, scraped } = await dispatch(url);

    expect(result).toMatchObject({
      error: {
        code: "tool_outside_data_boundary",
        message: expect.stringContaining("outside this organization's phi data boundary"),
      },
      state: "failed",
    });
    expect(scraped).toEqual([]);
  });

  test("run an allowlisted URL", async () => {
    const url = "https://claims.example.com/eligibility";

    const { result, scraped } = await dispatch(url);

    expect(result).toMatchObject({ state: "succeeded" });
    expect(scraped).toEqual([{ url }]);
  });
});
