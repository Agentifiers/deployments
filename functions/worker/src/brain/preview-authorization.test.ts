import { describe, expect, test } from "bun:test";
import type {
  Brain,
  BrainDeploymentMount,
  BrainGrant,
  BrainQueryRuntime,
  BrainRepository,
} from "@deployments-ai/brains";
import {
  key,
  Keys,
  type DynamoDatabaseService,
  type HoldReason,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { organizationHolds } from "@deployments-ai/organization-admission/testing";
import type { ToolAdapterDefinition } from "@deployments-ai/tools";
import { createBrainPublicationPreparer } from "./publication.ts";
import { createRuntimeBrainBuiltinExecutors } from "./runtime.ts";
import type { RunRecordValue } from "../types.ts";
import type { BrainToolRequest } from "./authorization.ts";

const ids = Array.from(
  { length: 16 },
  (_, index) => `01J000000000000000000000${String(index).padStart(2, "0")}`,
) as Ulid[];
const [
  organizationId,
  projectId,
  environmentId,
  serviceAccountId,
  credentialId,
  definitionId,
  bindingId,
  sourceDeploymentId,
  runId,
  threadId,
  toolCallId,
  brainId,
] = ids as [Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid];
const now = "2026-07-31T12:00:00.000Z";
const partition = key("ORG", organizationId, "ENV", environmentId);
const brainTools = ["agent.brain.search", "agent.brain.capture"].map((name) => ({
  name,
  required: false,
  requiredScopes: [],
}));

function platformRecord(
  itemType: PlatformRecord["itemType"],
  data: Readonly<Record<string, unknown>>,
  pk: string,
  sk: string,
) {
  return { data, itemType, pk, sk } as PlatformRecord;
}

function boundRun(purpose: "evaluation" | "preview") {
  return platformRecord(
    "run",
    {
      environmentId,
      executionBindingId: bindingId,
      executionPurpose: purpose,
      id: runId,
      idempotencyKey: "brain-run",
      initiatingCaller: {
        apiCredentialId: credentialId,
        serviceAccountId,
        type: "service-account",
      },
      organizationId,
      projectId,
      status: "running",
      threadId,
    },
    key("ORG", organizationId, "THREAD", threadId),
    key("RUN", "brain-run"),
  ) as RunRecordValue;
}

function database(
  purpose: "evaluation" | "preview",
  standing: readonly PlatformRecord[] = [],
): DynamoDatabaseService {
  const values = [
    platformRecord(
      "run-lookup",
      { environmentId, idempotencyKey: "brain-run", organizationId, projectId, runId, threadId },
      key("ORG", organizationId, "THREAD", threadId),
      key("RUN-LOOKUP", runId),
    ),
    boundRun(purpose),
    platformRecord(
      "execution-binding",
      {
        environmentId,
        expiresAt: "2999-01-01T00:00:00.000Z",
        id: bindingId,
        manifest: { spec: { capabilities: { tools: brainTools } } },
        organizationId,
        projectId,
        purpose,
        runtimeConfigSourceAgentDeploymentId: sourceDeploymentId,
        source: { type: "manifest" },
        status: "active",
      },
      partition,
      key("EXECUTION-BINDING", bindingId),
    ),
    platformRecord(
      "organization",
      { id: organizationId, status: "active" },
      key("ORG", organizationId),
      key("ORG", organizationId),
    ),
    platformRecord(
      "agent-definition",
      { environmentId, id: definitionId, organizationId, projectId, status: "active", version: 0 },
      partition,
      key("AGENT-DEFINITION", definitionId),
    ),
    // A stopped source deployment still lends its grants: the binding snapshot never runs it.
    platformRecord(
      "agent-deployment",
      {
        agentDefinitionId: definitionId,
        currentState: "stopped",
        desiredState: "stopped",
        environmentId,
        id: sourceDeploymentId,
        organizationId,
        projectId,
        version: 0,
      },
      partition,
      key("AGENT-DEPLOYMENT", sourceDeploymentId),
    ),
    platformRecord(
      "service-account",
      {
        environmentId,
        id: serviceAccountId,
        organizationId,
        projectId,
        scopes: ["brains:read", "brains:write"],
        status: "active",
      },
      partition,
      key("SERVICE-ACCOUNT", serviceAccountId),
    ),
    platformRecord(
      "api-credential",
      {
        environmentId,
        id: credentialId,
        organizationId,
        projectId,
        scopes: ["brains:read", "brains:write"],
        serviceAccountId,
        status: "active",
      },
      partition,
      key("API-CREDENTIAL", credentialId),
    ),
    ...standing,
  ];
  const byKey = new Map(values.map((value) => [`${value.pk}\n${value.sk}`, value]));
  return {
    deleteRecord: async () => {},
    getRecord: (_table, recordKey) =>
      Promise.resolve(byKey.get(`${recordKey.pk}\n${recordKey.sk}`)),
    putRecord: async () => {},
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: async () => {},
  };
}

const brain: Brain = {
  createdAt: now,
  createdByPrincipalId: ids[12]!,
  id: brainId,
  kind: "company",
  maintenancePolicy: {},
  name: "Company knowledge",
  organizationId,
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "company-knowledge",
  status: "active",
  updatedAt: now,
  updatedByPrincipalId: ids[12]!,
  version: 0,
};

const serviceGrant: BrainGrant = {
  brainId,
  brainKind: "company",
  createdAt: now,
  grantedByPrincipalId: ids[12]!,
  id: ids[13]!,
  organizationId,
  permission: "read-write",
  status: "active",
  target: { environmentId, projectId, serviceAccountId, type: "service-account" },
  updatedAt: now,
  version: 0,
};

const mount: BrainDeploymentMount = {
  agentDefinitionId: definitionId,
  agentDeploymentId: sourceDeploymentId,
  brainId,
  brainKind: "company",
  createdAt: now,
  environmentId,
  grantedByPrincipalId: ids[12]!,
  id: ids[15]!,
  organizationId,
  permission: "read-write",
  projectId,
  status: "active",
  updatedAt: now,
  version: 0,
};

function repository(mountedDeploymentIds: string[]) {
  return {
    findActiveGrant: async (_organizationId, _brainId, target) =>
      target.type === "agent-definition"
        ? target.agentDefinitionId === definitionId
          ? {
              ...serviceGrant,
              id: ids[14]!,
              target: {
                agentDefinitionId: definitionId,
                environmentId,
                projectId,
                type: target.type,
              },
            }
          : undefined
        : serviceGrant,
    findActiveMount: async (_organizationId, _brainId, agentDeploymentId) => {
      mountedDeploymentIds.push(agentDeploymentId);
      return agentDeploymentId === sourceDeploymentId ? mount : undefined;
    },
    get: async (_organizationId, requestedBrainId) =>
      requestedBrainId === brainId ? brain : undefined,
    getSource: async () => undefined,
  } as Partial<BrainRepository> as BrainRepository;
}

const queryRuntime: BrainQueryRuntime = {
  ask: async () => ({ claims: [], gaps: [], queryAttemptId: "query-attempt", usedCitations: [] }),
  search: async (input) => {
    if (!(await input.authorizeDisclosure(brainId))) throw new Error("disclosure denied");
    return { queryAttemptId: "query-attempt", results: [] };
  },
};

function request(
  purpose: "evaluation" | "preview",
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): BrainToolRequest {
  return {
    decision: { action: "allow" as const, reason: "test", toolCallId },
    effect: "read" as const,
    environmentId,
    executionBindingId: bindingId,
    executionPurpose: purpose,
    idempotencyKey: "brain-tool",
    input,
    inputSummary: "Brain tool",
    organizationId,
    projectId,
    requiredScopes: [],
    runId,
    threadId,
    toolName,
  };
}

function executors(
  purpose: "evaluation" | "preview",
  mountedDeploymentIds: string[] = [],
  standing: readonly PlatformRecord[] = [],
) {
  return createRuntimeBrainBuiltinExecutors({
    database: database(purpose, standing),
    generateId: async () => ids[14]!,
    loadQueryRuntime: async () => queryRuntime,
    repository: repository(mountedDeploymentIds),
    uploadContent: async () => {
      throw new Error("preview capture must not upload");
    },
  });
}

const definition = {} as ToolAdapterDefinition;
const search = { brainIds: [brainId], query: "What changed?" };

describe("preview and evaluation Brain access", () => {
  test("authorizes preview Brain reads through the source deployment's grant and mount", async () => {
    const mountedDeploymentIds: string[] = [];
    const result = await executors("preview", mountedDeploymentIds)["agent.brain.search"](
      request("preview", "agent.brain.search", search),
      definition,
    );

    expect(result).toMatchObject({
      output: { brainIds: [brainId], kind: "brain-evidence-provenance" },
      status: "completed",
    });
    expect(new Set(mountedDeploymentIds)).toEqual(new Set([sourceDeploymentId]));
  });

  test("lets a run read its Brains under a payment hold and denies them under a stopping hold", async () => {
    const outcome = async (reason: HoldReason) => {
      const memory = evaluationMemoryDatabase([]);
      await organizationHolds(memory.database, organizationId).hold(reason);
      const standing = await memory.database.getRecord(
        "control",
        Keys.control.organizationStanding(organizationId),
      );
      return executors("preview", [], standing ? [standing] : [])
        ["agent.brain.search"](request("preview", "agent.brain.search", search), definition)
        .then(
          (result) => result.status,
          (cause: Error) => cause.message,
        );
    };

    expect([await outcome("payment"), await outcome("abuse")]).toEqual([
      "completed",
      "Brain access is not authorized for this run.",
    ]);
  });

  test("denies preview Brain writes and every evaluation Brain read", async () => {
    expect(
      executors("preview")["agent.brain.capture"](
        {
          ...request("preview", "agent.brain.capture", {
            brainId,
            content: "Preview notes",
            externalItemIdentity: "preview-notes",
            sourceId: ids[13],
            title: "Preview notes",
          }),
          effect: "write",
        },
        definition,
      ),
    ).rejects.toThrow("Brain access is not authorized for this run.");
    expect(
      executors("evaluation")["agent.brain.search"](
        request("evaluation", "agent.brain.search", search),
        definition,
      ),
    ).rejects.toThrow("Brain access is not authorized for this run.");
  });

  test("never publishes Brain-derived answers from preview runs", async () => {
    const recorded: unknown[] = [];
    const prepare = createBrainPublicationPreparer({
      database: database("preview"),
      recordArtifact: async (artifact) => {
        recorded.push(artifact);
        return undefined as never;
      },
      repository: repository([]),
    });

    expect(
      prepare({
        body: "Answer copied from Brain evidence.",
        brainEvidence: [],
        brainToolCalls: [
          {
            effect: "read",
            idempotencyKey: "brain-tool",
            input: search,
            inputSummary: "Brain tool",
            output: { brainIds: [brainId], citations: [], kind: "brain-evidence-provenance" },
            outputSummary: "Evidence",
            policyAction: "allow",
            policyReason: "test",
            requiredScopes: [],
            toolCallId,
            toolName: "agent.brain.search",
          },
        ],
        run: boundRun("preview"),
      }),
    ).rejects.toThrow("Brain publication requires a deployed agent run.");
    expect(recorded).toEqual([]);
  });
});
