import { describe, expect, test } from "bun:test";
import { marshall } from "@aws-sdk/util-dynamodb";
import { makeDynamoBrainQueryTelemetry } from "@deployments-ai/brain-runtime";
import {
  makeBrainQueryRuntime,
  type BrainModelUsageScope,
  type BrainRepository,
  type BrainSearchProviderClient,
  type BrainSearchTarget,
} from "@deployments-ai/brains";
import type { DynamoDatabaseService, PlatformRecord, Ulid } from "@deployments-ai/db";
import { processObservabilityDynamoStream } from "../observability-normalizer-main.ts";
import { createRuntimeBrainRecall } from "./active-recall.ts";
import { createRuntimeBrainBuiltinExecutors } from "./runtime.ts";
import {
  brainId,
  credentialId,
  database,
  definition,
  definitionId,
  deploymentId,
  environmentId,
  ids,
  organizationId,
  projectId,
  records,
  releaseId,
  repository,
  runId,
  serviceAccountId,
  threadId,
  toolCallId,
} from "./runtime.fixture.ts";

const trace = {
  agentManifestHash: "release-content-hash",
  captureMode: "metadata-only" as const,
  spanId: "0123456789abcdef",
  traceId: "0123456789abcdef0123456789abcdef",
};

const workspaceId = "01J000000000000000000000WS" as Ulid;

function brainUsage() {
  const meters: PlatformRecord[] = [];
  const modelUsageScopes: (BrainModelUsageScope | undefined)[] = [];
  const generated = [ids[12]!, ids[13]!];
  const telemetryDatabase: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: async () => undefined,
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "put" && operation.record.itemType === "meter-event") {
          meters.push(operation.record);
        }
      }
    },
  };
  const target: BrainSearchTarget = {
    location: {},
    providerId: "aws-native",
    schemaGeneration: 1,
    targetId: ids[15]!,
  };
  const provider = {
    providerId: "aws-native",
    search: async () => [],
    target,
  } as unknown as BrainSearchProviderClient;
  const queryRuntime = makeBrainQueryRuntime({
    answerModel: {} as never,
    embeddings: {
      embedQuery: async (request) => {
        modelUsageScopes.push(request.usageScope);
        return [0.1, 0.2];
      },
    },
    hydrator: { hydrateExcerpt: async () => "" },
    placement: { resolve: async () => ({ placementGeneration: 1, provider, target }) },
    repository: {} as BrainRepository,
    telemetry: makeDynamoBrainQueryTelemetry({
      database: telemetryDatabase,
      generateId: async () => generated.shift()!,
      now: () => new Date("2026-07-31T12:00:00.000Z"),
    }),
  });
  return { meters, modelUsageScopes, queryRuntime };
}

async function normalizedUsage(meters: readonly PlatformRecord[]) {
  const facts: unknown[] = [];
  const result = await processObservabilityDynamoStream(
    {
      Records: meters.map((meter, index) => ({
        dynamodb: {
          NewImage: marshall(meter, { removeUndefinedValues: true }),
          SequenceNumber: String(index + 1),
        },
        eventID: `event-${index + 1}`,
        eventName: "INSERT",
        eventSourceARN: "arn:aws:dynamodb:us-east-2:123:table/usage/stream/1",
      })),
    },
    "usage",
    {
      organizationExists: async () => true,
      quarantine: async () => "retry",
      writeFacts: async (encoded) => {
        facts.push(
          ...encoded.map(({ fact }) => ({
            factType: fact.factType,
            payload: fact.payload,
            scope: fact.scope,
            trace: fact.trace,
          })),
        );
        return [];
      },
    },
  );
  return { batchItemFailures: result.batchItemFailures, facts };
}

const expectedUsage = {
  batchItemFailures: [],
  facts: [
    {
      factType: "usage.recorded",
      payload: {
        idempotencyKey: `brain-query:${ids[12]}`,
        metric: "brain.retrieval",
        provider: "aws-native",
        quantity: 1,
        source: "brain-runtime",
        unit: "request",
      },
      scope: { environmentId, organizationId, projectId },
      trace: { runId, sessionId: threadId, spanId: trace.spanId, traceId: trace.traceId },
    },
  ],
};

describe("Brain usage observability", () => {
  test("a Brain search tool call records usage that normalizes onto the run's trace", async () => {
    const usage = brainUsage();
    const executors = createRuntimeBrainBuiltinExecutors({
      database: database(
        records({ apiCredentialId: credentialId, serviceAccountId, type: "service-account" }),
      ),
      loadQueryRuntime: async () => usage.queryRuntime,
      repository: repository({ revoked: false }),
    });

    const result = await executors["agent.brain.search"](
      {
        ...trace,
        agentDefinitionId: definitionId,
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        decision: { action: "allow" as const, reason: "test", toolCallId },
        effect: "read" as const,
        environmentId,
        idempotencyKey: "brain-search",
        input: { brainIds: [brainId], query: "What changed?" },
        inputSummary: "Search company knowledge",
        organizationId,
        projectId,
        requiredScopes: [],
        runId,
        threadId,
        toolName: "agent.brain.search",
      },
      definition,
    );

    expect(result.status).toBe("completed");
    expect(await normalizedUsage(usage.meters)).toEqual(expectedUsage);
  });

  test("a Brain search tool call in a workspace meters its model and retrieval usage there", async () => {
    const usage = brainUsage();
    const executors = createRuntimeBrainBuiltinExecutors({
      database: database(
        records(
          { apiCredentialId: credentialId, serviceAccountId, type: "service-account" },
          workspaceId,
        ),
      ),
      loadQueryRuntime: async () => usage.queryRuntime,
      repository: repository({ revoked: false }),
    });

    const result = await executors["agent.brain.search"](
      {
        ...trace,
        agentDefinitionId: definitionId,
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        decision: { action: "allow" as const, reason: "test", toolCallId },
        effect: "read" as const,
        environmentId,
        idempotencyKey: "brain-search",
        input: { brainIds: [brainId], query: "What changed?" },
        inputSummary: "Search company knowledge",
        organizationId,
        projectId,
        requiredScopes: [],
        runId,
        threadId,
        toolName: "agent.brain.search",
        workspaceId,
      },
      definition,
    );

    expect(result.status).toBe("completed");
    expect(usage.modelUsageScopes.map((scope) => scope?.workspaceId)).toEqual([workspaceId]);
    expect(
      usage.meters.map((meter) => (meter.itemType === "meter-event" ? meter.data.workspaceId : "")),
    ).toEqual([workspaceId]);
  });

  test("active Brain recall records usage that normalizes onto the run's trace", async () => {
    const usage = brainUsage();
    const recall = createRuntimeBrainRecall({
      database: database(
        records({ apiCredentialId: credentialId, serviceAccountId, type: "service-account" }),
      ),
      loadQueryRuntime: async () => usage.queryRuntime,
      repository: repository({ revoked: false }),
    });

    await recall.recall({
      ...trace,
      agentDefinitionId: definitionId,
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      brainRetrievalMode: "hybrid",
      environmentId,
      memories: [
        {
          content: "The user prefers citations.",
          memoryId: ids[14]!,
          score: 0.9,
          sensitivity: "internal",
        },
      ],
      organizationId,
      projectId,
      prompt: "Cite what changed in the rollout; I prefer short answers.",
      recentMessages: [],
      runId,
      threadId,
    });

    expect(await normalizedUsage(usage.meters)).toEqual(expectedUsage);
  });
});
