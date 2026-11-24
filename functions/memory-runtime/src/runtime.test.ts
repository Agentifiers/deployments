import { describe, expect, it, spyOn } from "bun:test";
import { LambdaClient } from "@aws-sdk/client-lambda";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { type DynamoDatabaseService } from "@deployments-ai/db";
import { Effect } from "effect";
import {
  MemoryRerankUsagePersistenceError,
  memoryContentHash,
  type MemoryBlobReference,
  type MemorySearchTarget,
} from "@deployments-ai/memory";
import {
  deleteMemoryBlobWithClient,
  memoryBlobBucketFromEnv,
  memoryModelGateway,
  memoryModelTokenContext,
  persistMemoryRerankUsage,
  runtimeMemoryPlatform,
  runtimeMemorySearchRegistry,
} from "./runtime.ts";
import { memorySearchTargetIdentity } from "./target-identity.ts";
const bucket = "platform-artifacts";
const content = "Legacy versionless memory content.";
const bytes = new TextEncoder().encode(content);
const reference: MemoryBlobReference = {
  bucket,
  byteSize: bytes.byteLength,
  contentType: "text/plain; charset=utf-8",
  key: "memory/legacy.txt",
  sha256: memoryContentHash(content),
};

describe("memory runtime blob cleanup", () => {
  it("uses canonical agent-runtime environment values when legacy aliases are absent", () => {
    expect(
      memoryBlobBucketFromEnv({
        DEPLOYMENTS_AI_ARTIFACT_BUCKET: "canonical-artifacts",
      }),
    ).toBe("canonical-artifacts");
    expect(
      memoryBlobBucketFromEnv({
        DEPLOYMENTS_AI_ARTIFACT_BUCKET: "canonical-artifacts",
        DEPLOYMENTS_AI_MEMORY_BLOB_BUCKET: "legacy-memory-artifacts",
      }),
    ).toBe("legacy-memory-artifacts");
  });

  it("attributes service tokens to the route scope's tenancy", () => {
    expect(memoryModelTokenContext(undefined)).toEqual({});
    expect(
      memoryModelTokenContext({
        agentId: "agent",
        organizationId: "organization",
        runId: "run",
        workspaceId: "workspace",
      }),
    ).toEqual({
      agentDefinitionId: "agent",
      organizationId: "organization",
      runId: "run",
      workspaceId: "workspace",
    });
  });

  it("keys provider clients by the complete immutable target identity", () => {
    const target = {
      componentIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA1"],
      embeddingProfileId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
      location: { endpoint: "search-a.example", region: "us-east-1" },
      providerId: "aws-native",
      schemaGeneration: 1,
      targetId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
    } as unknown as MemorySearchTarget;
    expect(memorySearchTargetIdentity(target)).toBe(
      memorySearchTargetIdentity({
        ...target,
        location: { region: "us-east-1", endpoint: "search-a.example" },
      }),
    );
    expect(memorySearchTargetIdentity(target)).not.toBe(
      memorySearchTargetIdentity({
        ...target,
        location: { endpoint: "search-b.example", region: "us-east-1" },
      }),
    );
  });

  it("constructs purge-capable AWS providers from retired embedding profiles", async () => {
    const previousEndpoint = process.env.DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT;
    process.env.DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT =
      "https://search.example.us-east-1.es.amazonaws.com";
    const profile = {
      data: { dimensions: 3, status: "retired" },
      itemType: "memory-embedding-profile",
    } as never;
    const database = {
      getRecord: async () => profile,
    } as unknown as DynamoDatabaseService;
    const target = {
      componentIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA4"],
      embeddingProfileId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
      location: {
        automatedSnapshotRetentionHours: 336,
        backupSafetyMarginMinutes: 60,
        embeddingDimensions: 3,
        openSearchEndpoint: "https://search.example.us-east-1.es.amazonaws.com",
        openSearchIndex: "memory-v1",
        region: "us-east-1",
      },
      providerId: "aws-native",
      schemaGeneration: 1,
      targetId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
    } as unknown as MemorySearchTarget;

    try {
      const provider = await runtimeMemorySearchRegistry(database).resolve(target);

      expect(provider.providerId).toBe("aws-native");
      expect(typeof provider.purgeOrganization).toBe("function");
    } finally {
      if (previousEndpoint === undefined) {
        delete process.env.DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT;
      } else {
        process.env.DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT = previousEndpoint;
      }
    }
  });

  it("requires either durable usage persistence or a durable retry", async () => {
    const usageCause = new Error("usage unavailable");
    const retryCause = new Error("queue unavailable");

    expect(
      persistMemoryRerankUsage(
        async () => Promise.reject(usageCause),
        async () => Promise.reject(retryCause),
      ),
    ).rejects.toMatchObject({
      cause: { retryCause, usageCause },
      name: "MemoryRerankUsagePersistenceError",
    } satisfies Partial<MemoryRerankUsagePersistenceError>);
  });

  it("does not enqueue a rerank usage retry after its deadline aborts", async () => {
    const controller = new AbortController();
    let retries = 0;
    expect(
      persistMemoryRerankUsage(
        async () => {
          controller.abort(new Error("deadline exceeded"));
          throw new Error("usage unavailable");
        },
        async () => {
          retries += 1;
        },
        controller.signal,
      ),
    ).rejects.toThrow("deadline exceeded");
    expect(retries).toBe(0);
  });

  it("constructs DynamoDB-only platform operations without external credentials", async () => {
    const previous = {
      baseUrl: process.env.DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL,
      tokenIssuer: process.env.DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER,
    };
    delete process.env.DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL;
    delete process.env.DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER;
    try {
      expect(runtimeMemoryPlatform()).resolves.toBeDefined();
    } finally {
      for (const [name, value] of Object.entries({
        DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL: previous.baseUrl,
        DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER: previous.tokenIssuer,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("purges matching versions while preserving unrelated exact-key history", async () => {
    const commands: unknown[] = [];
    let listCalls = 0;
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof ListObjectVersionsCommand) {
          listCalls += 1;
          if (listCalls > 1) return {};
          return {
            DeleteMarkers: [{ Key: reference.key, VersionId: "delete-1" }],
            Versions: [
              { IsLatest: true, Key: reference.key, VersionId: "version-2" },
              { Key: reference.key, VersionId: "version-1" },
              { Key: `${reference.key}.other`, VersionId: "other-version" },
            ],
          };
        }
        if (command instanceof GetObjectCommand) {
          const body = command.input.VersionId === "version-2" ? bytes : new Uint8Array([1]);
          return { Body: { transformToByteArray: async () => body } };
        }
        if (command instanceof DeleteObjectsCommand) return { Errors: [] };
        throw new Error("Unexpected S3 command.");
      },
    } as unknown as S3Client;

    await deleteMemoryBlobWithClient(client, reference, "canonical-artifacts", [bucket]);

    const deletion = commands.find(
      (command): command is DeleteObjectsCommand => command instanceof DeleteObjectsCommand,
    );
    expect(deletion?.input.Delete?.Objects).toEqual([
      { Key: reference.key, VersionId: "version-2" },
    ]);
  });

  it("re-lists and removes a version created during versionless cleanup", async () => {
    const commands: unknown[] = [];
    let listCalls = 0;
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof ListObjectVersionsCommand) {
          listCalls += 1;
          if (listCalls === 1) {
            return { Versions: [{ Key: reference.key, VersionId: "version-1" }] };
          }
          if (listCalls === 2) {
            return { Versions: [{ Key: reference.key, VersionId: "version-2" }] };
          }
          return {};
        }
        if (command instanceof GetObjectCommand) {
          return { Body: { transformToByteArray: async () => bytes } };
        }
        if (command instanceof DeleteObjectsCommand) return { Errors: [] };
        throw new Error("Unexpected S3 command.");
      },
    } as unknown as S3Client;

    await deleteMemoryBlobWithClient(client, reference, bucket);

    expect(
      commands
        .filter(
          (command): command is DeleteObjectsCommand => command instanceof DeleteObjectsCommand,
        )
        .map((command) => command.input.Delete?.Objects),
    ).toEqual([
      [{ Key: reference.key, VersionId: "version-1" }],
      [{ Key: reference.key, VersionId: "version-2" }],
    ]);
  });

  it("deletes only the verified version for a versioned reference", async () => {
    const commands: unknown[] = [];
    const versionedReference = { ...reference, versionId: "version-1" };
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetObjectCommand) {
          expect(command.input.VersionId).toBe("version-1");
          return { Body: { transformToByteArray: async () => bytes } };
        }
        if (command instanceof DeleteObjectsCommand) return { Errors: [] };
        throw new Error("Unexpected S3 command.");
      },
    } as unknown as S3Client;

    await deleteMemoryBlobWithClient(client, versionedReference, bucket);

    const deletion = commands.find(
      (command): command is DeleteObjectsCommand => command instanceof DeleteObjectsCommand,
    );
    expect(deletion?.input.Delete?.Objects).toEqual([
      { Key: reference.key, VersionId: "version-1" },
    ]);
    expect(commands.some((command) => command instanceof ListObjectVersionsCommand)).toBe(false);
  });

  it("treats an already deleted version as an idempotent cleanup success", async () => {
    const commands: unknown[] = [];
    const versionedReference = { ...reference, versionId: "version-1" };
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetObjectCommand) {
          throw Object.assign(new Error("missing version"), { name: "NoSuchVersion" });
        }
        throw new Error("Unexpected S3 command.");
      },
    } as unknown as S3Client;

    expect(deleteMemoryBlobWithClient(client, versionedReference, bucket)).resolves.toBe(undefined);
    expect(commands.some((command) => command instanceof DeleteObjectsCommand)).toBe(false);
  });

  it("preserves versionless objects whose content changed", async () => {
    const commands: unknown[] = [];
    let listCalls = 0;
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof ListObjectVersionsCommand) {
          listCalls += 1;
          if (listCalls > 1) return {};
          return { Versions: [{ IsLatest: true, Key: reference.key, VersionId: "version-2" }] };
        }
        if (command instanceof GetObjectCommand) {
          return {
            Body: { transformToByteArray: async () => new TextEncoder().encode("changed") },
          };
        }
        if (command instanceof DeleteObjectsCommand) return { Errors: [] };
        throw new Error("Unexpected S3 command.");
      },
    } as unknown as S3Client;

    expect(deleteMemoryBlobWithClient(client, reference, bucket)).resolves.toBeUndefined();
    expect(commands.some((command) => command instanceof DeleteObjectsCommand)).toBe(false);
  });
});

describe("memory model gateway", () => {
  async function sentFallbacks(environment: Readonly<Record<string, string | undefined>>) {
    const send = spyOn(LambdaClient.prototype, "send").mockResolvedValue({
      Payload: Buffer.from(
        JSON.stringify({ expiresAt: 4_102_444_800, models: [], ok: true, token: "memory-token" }),
      ),
    } as never);
    const bodies: Record<string, unknown>[] = [];
    try {
      await Effect.runPromiseExit(
        memoryModelGateway(undefined, {
          DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL: "https://gateway.internal",
          DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER: "memory-token-issuer",
          ...environment,
        }).chatCompletion({
          fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
            bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
            return new Response("refused", { status: 400 });
          }) as typeof fetch,
          messages: [{ content: "Rank these memories.", role: "user" }],
          modelId: "openai/gpt-6-luna",
          scope: { organizationId: "org_1" },
        }),
      );
    } finally {
      send.mockRestore();
    }
    return bodies.map((body) => body.fallbacks);
  }

  it("requests the deployment's configured fallbacks", async () => {
    expect(
      await sentFallbacks({
        DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS: "openai/gpt-5.6-luna, openai/gpt-6-sol",
      }),
    ).toEqual([["openai/gpt-5.6-luna", "openai/gpt-6-sol"]]);
  });

  it("keeps the code default fallbacks when none are configured", async () => {
    expect(await sentFallbacks({})).toEqual([
      ["openrouter/z-ai/glm-5.2", "openrouter/xiaomi/mimo-v2.5"],
    ]);
  });
});
