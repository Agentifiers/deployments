import { describe, expect, test } from "bun:test";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { BrainAnswerInvalidError } from "@deployments-ai/brains";
import {
  BrainSearchPlacementRecord,
  MemoryEmbeddingProfileRecord,
  Ulid,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  ModelGatewayEmbeddingResponseError,
  type ModelGatewayChatCompletionRequest,
  type ModelGatewayEmbeddingRequest,
  modelGatewayRouteIdentity,
  type ModelGatewayRoute,
  type ModelGatewayService,
} from "@deployments-ai/model-gateway";
import { Effect, Schema } from "effect";
import { makeBrainAnswerModel } from "./answer-model.ts";
import { makeBrainIndexEmbeddingPort, makeBrainQueryEmbeddingPort } from "./embedding.ts";
import { makeBrainSearchProviderRegistry } from "./provider-registry.ts";
import { makeApprovedBrainRenditionGetObject } from "./runtime.ts";
import type { BrainModelUsageRecorder } from "./usage-identity.ts";

const ids = Array.from(
  { length: 10 },
  (_, index) => `01J000000000000000000000${String(index).padStart(2, "0")}`,
).map((value) => Schema.decodeUnknownSync(Ulid)(value));
const [organizationId, profileId, targetId, ...componentIds] = ids as [
  typeof Ulid.Type,
  typeof Ulid.Type,
  typeof Ulid.Type,
  ...(typeof Ulid.Type)[],
];
const now = "2026-07-31T12:00:00.000Z";
const environmentId = ids[8]!;
const projectId = ids[9]!;

function usage(runId: string) {
  return {
    idempotencyKey: `${runId}:model_tokens:test`,
    modelId: route.modelId,
    occurredAt: now,
    payer: { kind: "operator" as const },
    provider: route.provider,
    quantity: 5,
    runId,
    source: "model-gateway",
    type: "model_tokens" as const,
    unit: "tokens" as const,
  };
}

const route: ModelGatewayRoute = {
  bifrostModelId: "text-embedding-3-small",
  fallbackModelIds: [],
  modelId: "openai/text-embedding-3-small",
  provider: "openai",
  providerModelId: "text-embedding-3-small",
  requestedModelId: "openai/text-embedding-3-small",
};

function database() {
  const profile = Schema.decodeUnknownSync(MemoryEmbeddingProfileRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now,
        dimensions: 3,
        distanceMetric: "cosine" as const,
        gatewayModel: route.modelId,
        gatewayRoute: modelGatewayRouteIdentity(route),
        id: profileId,
        normalization: "l2" as const,
        processingBoundary: "platform-approved" as const,
        status: "active" as const,
        updatedAt: now,
        version: 0,
      },
      itemType: "memory-embedding-profile" as const,
    }),
  );
  const components = ["dense", "lexical", "exact", "entity"].map((kind, index) => ({
    componentId: componentIds[index]!,
    kind: kind as "dense" | "entity" | "exact" | "lexical",
  }));
  const target = {
    components,
    embeddingProfileId: profileId,
    location: {},
    providerId: "aws-native" as const,
    schemaGeneration: 1,
    targetId,
  };
  const placement = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now,
        generation: 1,
        organizationId,
        phase: "active" as const,
        readTarget: target,
        updatedAt: now,
        version: 1,
        writeTarget: target,
      },
      itemType: "brain-search-placement" as const,
    }),
  );
  const values = new Map<string, PlatformRecord>([
    [`${profile.pk}\n${profile.sk}`, profile],
    [`${placement.pk}\n${placement.sk}`, placement],
  ]);
  return {
    deleteRecord: async () => {},
    getRecord: async (_table, recordKey) => values.get(`${recordKey.pk}\n${recordKey.sk}`),
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async () => {},
  } as DynamoDatabaseService;
}

describe("Brain production query runtime", () => {
  test("hydrates retained legacy renditions while rejecting unknown buckets", async () => {
    const commands: GetObjectCommand[] = [];
    const abortSignals: unknown[] = [];
    const getObject = makeApprovedBrainRenditionGetObject({
      contentBucket: "current-content",
      legacyContentBuckets: ["legacy-content"],
      s3: {
        send: async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
          commands.push(command as GetObjectCommand);
          abortSignals.push(options?.abortSignal);
          return { $metadata: {} };
        },
      } as Pick<S3Client, "send">,
    });
    const deadline = new AbortController();
    const request = {
      Bucket: "legacy-content",
      Key: `organizations/${organizationId}/brains/brain/rendition`,
      VersionId: "version",
    };

    expect(getObject(request, { abortSignal: deadline.signal })).resolves.toEqual({
      $metadata: {},
    });
    expect(commands[0]?.input.Bucket).toBe("legacy-content");
    expect(abortSignals).toEqual([deadline.signal]);
    expect(getObject({ ...request, Bucket: "unknown-content" }, {})).rejects.toThrow(
      "approved content boundary",
    );
  });

  test("pins query embeddings to the active immutable profile and normalizes them", async () => {
    const calls: unknown[] = [];
    const routeRequests: unknown[] = [];
    let gatewayLoads = 0;
    const recorded: Parameters<BrainModelUsageRecorder>[0][] = [];
    const gateway = {
      embedding: (request: ModelGatewayEmbeddingRequest) => {
        calls.push(request);
        return Effect.succeed({
          body: {},
          embedding: [3, 4, 0],
          modelId: route.modelId,
          provider: route.provider,
          usage: usage(request.runId!),
        });
      },
      resolveRoute: (request: unknown) => {
        routeRequests.push(request);
        return Effect.succeed(route);
      },
    } as unknown as ModelGatewayService;

    const embedding = await makeBrainQueryEmbeddingPort({
      database: database(),
      gateway: async () => {
        gatewayLoads += 1;
        return gateway;
      },
      recordUsage: async (input) => {
        recorded.push(input);
      },
    }).embedQuery({
      organizationId,
      query: "What changed?",
      usageOperationId: "query-operation-1",
      usageScope: { environmentId, organizationId, projectId, workspaceId: undefined },
    });

    expect(embedding).toEqual([0.6, 0.8, 0]);
    expect(gatewayLoads).toBe(1);
    expect(calls[0]).toMatchObject({
      dimensions: 3,
      modelId: route.modelId,
      runId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
    });
    expect(routeRequests).toEqual([
      expect.objectContaining({ routeIdentity: modelGatewayRouteIdentity(route) }),
    ]);
    expect(recorded).toEqual([
      {
        entry: expect.objectContaining({ quantity: 5 }),
        operationId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
        operationType: "brain-query-embedding",
        scope: { environmentId, organizationId, projectId, workspaceId: undefined },
      },
    ]);
  });

  test("keeps query model runs stable only within one logical invocation", async () => {
    const runIds: string[] = [];
    const modelCallIds: string[] = [];
    const gateway = {
      embedding: (request: ModelGatewayEmbeddingRequest) => {
        runIds.push(request.runId!);
        modelCallIds.push(request.modelCallId!);
        return Effect.succeed({
          body: {},
          embedding: [3, 4, 0],
          modelId: route.modelId,
          provider: route.provider,
        });
      },
      resolveRoute: () => Effect.succeed(route),
    } as unknown as ModelGatewayService;
    const port = makeBrainQueryEmbeddingPort({ database: database(), gateway });
    const request = {
      organizationId,
      query: "What changed?",
      usageOperationId: "query-operation-1",
    };

    await port.embedQuery(request);
    await port.embedQuery(request);
    await port.embedQuery({ ...request, usageOperationId: "query-operation-2" });

    expect(runIds[0]).toBe(runIds[1]);
    expect(runIds[2]).not.toBe(runIds[0]);
    expect(modelCallIds[0]).not.toBe(modelCallIds[1]);
  });

  test("records billable usage attached to a rejected embedding response", async () => {
    const recorded: Parameters<BrainModelUsageRecorder>[0][] = [];
    const failedUsage = usage("01J00000000000000000000020");
    const gateway = {
      embedding: () =>
        Effect.fail(
          new ModelGatewayEmbeddingResponseError({
            message: "Embedding response contained no vector.",
            modelCallId: "query-attempt",
            usage: failedUsage,
          }),
        ),
      resolveRoute: () => Effect.succeed(route),
    } as unknown as ModelGatewayService;

    expect(
      makeBrainQueryEmbeddingPort({
        database: database(),
        gateway,
        recordUsage: async (input) => {
          recorded.push(input);
        },
      }).embedQuery({
        organizationId,
        query: "What changed?",
        usageOperationId: "rejected-query-operation",
        usageScope: { environmentId, organizationId, projectId, workspaceId: undefined },
      }),
    ).rejects.toThrow("no vector");

    expect(recorded).toEqual([
      expect.objectContaining({
        entry: failedUsage,
        operationType: "brain-query-embedding",
        scope: { environmentId, organizationId, projectId, workspaceId: undefined },
      }),
    ]);
  });

  test("records successful provider usage before rejecting local embedding provenance", async () => {
    const recorded: Parameters<BrainModelUsageRecorder>[0][] = [];
    const successfulUsage = usage("01J00000000000000000000021");
    const gateway = {
      embedding: () =>
        Effect.succeed({
          body: {},
          embedding: [3, 4, 0],
          modelId: route.modelId,
          provider: "openrouter",
          usage: successfulUsage,
        }),
      resolveRoute: () => Effect.succeed(route),
    } as unknown as ModelGatewayService;

    expect(
      makeBrainQueryEmbeddingPort({
        database: database(),
        gateway,
        recordUsage: async (input) => {
          recorded.push(input);
        },
      }).embedQuery({
        organizationId,
        query: "What changed?",
        usageOperationId: "mismatched-query-operation",
        usageScope: { environmentId, organizationId, projectId, workspaceId: undefined },
      }),
    ).rejects.toThrow("provenance");

    expect(recorded).toEqual([
      expect.objectContaining({
        entry: successfulUsage,
        operationType: "brain-query-embedding",
        scope: { environmentId, organizationId, projectId, workspaceId: undefined },
      }),
    ]);
  });

  test("uses a stable canonical usage run for index embeddings", async () => {
    const calls: unknown[] = [];
    const gateway = {
      embedding: (request: unknown) => {
        calls.push(request);
        return Effect.succeed({
          body: {},
          embedding: [3, 4, 0],
          modelId: route.modelId,
          provider: route.provider,
        });
      },
      resolveRoute: () => Effect.succeed(route),
    } as unknown as ModelGatewayService;
    const port = makeBrainIndexEmbeddingPort({
      database: database(),
      gateway,
      organizationId,
      profileId,
    });

    await port.embed({ modelCallId: `${targetId}:0`, text: "Evidence" });

    expect(calls[0]).toMatchObject({
      runId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
    });
  });

  test("parses bounded cited synthesis and rejects malformed model output", async () => {
    const recorded: Parameters<BrainModelUsageRecorder>[0][] = [];
    let assistantMessage = JSON.stringify({
      claims: [{ citationIds: ["citation-1"], text: "The rollout changed." }],
      gaps: ["The exact owner is not in the evidence."],
    });
    const gateway = {
      chatCompletion: (request: ModelGatewayChatCompletionRequest) =>
        Effect.succeed({
          assistantMessage,
          body: {},
          modelCallId: "call",
          route,
          usage: usage(request.runId!),
        }),
    } as unknown as ModelGatewayService;
    const model = makeBrainAnswerModel({
      gateway,
      recordUsage: async (input) => {
        recorded.push(input);
      },
    });

    expect(
      model.synthesize({
        evidence: [{ citationId: "citation-1", excerpt: "Changed Tuesday." }],
        organizationId,
        question: "What changed?",
        usageOperationId: "answer-operation-1",
        usageScope: { environmentId, organizationId, projectId, workspaceId: undefined },
      }),
    ).resolves.toEqual({
      claims: [{ citationIds: ["citation-1"], text: "The rollout changed." }],
      gaps: ["The exact owner is not in the evidence."],
    });
    expect(recorded).toEqual([
      {
        entry: expect.objectContaining({ quantity: 5 }),
        operationId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
        operationType: "brain-answer",
        scope: { environmentId, organizationId, projectId, workspaceId: undefined },
      },
    ]);

    // Shape served by openrouter/z-ai/glm-5.2 in dev: a lone "{" line before the JSON object.
    assistantMessage = `{\n{"claims":[{"text":"The rollout changed.","citationIds":["citation-1"]}],"gaps":[]}`;
    const failure = await model
      .synthesize({
        evidence: [],
        question: "What changed?",
        usageOperationId: "answer-operation-2",
      })
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(BrainAnswerInvalidError);
    expect(failure).toMatchObject({ rejection: "malformed-json", status: 502 });
    expect((failure as Error).message).not.toContain("rollout");
  });

  test("keeps answer model runs stable only within one logical invocation", async () => {
    const runIds: string[] = [];
    const modelCallIds: string[] = [];
    const gateway = {
      chatCompletion: (request: ModelGatewayChatCompletionRequest) => {
        runIds.push(request.runId!);
        modelCallIds.push(request.modelCallId!);
        return Effect.succeed({
          assistantMessage: JSON.stringify({ claims: [], gaps: [] }),
          body: {},
          modelCallId: "call",
          route,
        });
      },
    } as unknown as ModelGatewayService;
    const model = makeBrainAnswerModel({ gateway });
    const request = {
      evidence: [{ citationId: "citation-1", excerpt: "Changed Tuesday." }],
      question: "What changed?",
      usageOperationId: "answer-operation-1",
    };

    await model.synthesize(request);
    await model.synthesize(request);
    await model.synthesize({ ...request, usageOperationId: "answer-operation-2" });

    expect(runIds[0]).toBe(runIds[1]);
    expect(runIds[2]).not.toBe(runIds[0]);
    expect(modelCallIds[0]).not.toBe(modelCallIds[1]);
  });

  test("does not repeat the identical prompt on the recovery attempt", async () => {
    const systemPrompts: string[] = [];
    const gateway = {
      chatCompletion: (request: ModelGatewayChatCompletionRequest) => {
        systemPrompts.push(String(request.messages[0]!.content));
        return Effect.succeed({
          assistantMessage: JSON.stringify({ claims: [], gaps: [] }),
          body: {},
          modelCallId: "call",
          route,
        });
      },
    } as unknown as ModelGatewayService;
    const model = makeBrainAnswerModel({ gateway });
    const request = {
      evidence: [{ citationId: "citation-1", excerpt: "Changed Tuesday." }],
      question: "What changed?",
      usageOperationId: "answer-operation-1",
    };

    await model.synthesize(request);
    await model.synthesize({ ...request, recovery: "same-model-retry" });

    expect(systemPrompts[1]).not.toBe(systemPrompts[0]);
    expect(systemPrompts[1]!.startsWith(systemPrompts[0]!)).toBe(true);
  });

  test("rejects reuse of a provider target ID with conflicting immutable identity", async () => {
    const endpoint = "https://brain-search.example.com";
    const registry = makeBrainSearchProviderRegistry({
      config: { aws: { openSearchEndpoint: endpoint } },
      database: database(),
    });
    const target = {
      embeddingProfileId: profileId,
      location: {
        openSearchEndpoint: endpoint,
        openSearchIndex: "brain-organization-v1",
        region: "us-east-1",
      },
      providerId: "aws-native" as const,
      schemaGeneration: 1,
      targetId,
    };
    expect(registry.resolve(target)).resolves.toMatchObject({
      providerId: "aws-native",
    });
    expect(() => registry.resolve({ ...target, schemaGeneration: 2 })).toThrow("identity changed");
  });

  test("resolves the AWS-native provider from OpenSearch settings alone", async () => {
    const endpoint = "https://brain-search.example.com";
    const registry = makeBrainSearchProviderRegistry({
      config: { aws: { openSearchEndpoint: endpoint } },
      database: database(),
    });
    expect(
      registry.resolve({
        embeddingProfileId: profileId,
        location: {
          openSearchEndpoint: endpoint,
          openSearchIndex: "brain-organization-v1",
          region: "us-east-1",
        },
        providerId: "aws-native",
        schemaGeneration: 1,
        targetId,
      }),
    ).resolves.toMatchObject({
      providerId: "aws-native",
      target: { targetId },
    });
  });
});
