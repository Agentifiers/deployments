import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { LambdaClient } from "@aws-sdk/client-lambda";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
  type ObjectIdentifier,
} from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeDynamoDatabase,
  makeIdGenerator,
  type ObservabilitySourceContext,
  tableNamesFromEnvironment,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import {
  awsNativeTargetLocation,
  makeAwsNativeMemoryProvider,
  makeMemorySearchPlacementResolver,
  makeMemorySearchRoutingResolver,
  makeMemoryPlatform,
  memoryRerankPrompt,
  MEMORY_RERANK_SYSTEM_PROMPT,
  MemoryRerankUsagePersistenceError,
  parseMemoryRerankCompletion,
  InvalidMemoryPageCursorError,
  type MemoryBlobReference,
  type MemoryPlatform,
  type MemoryRerankRequest,
  type MemorySearchProviderClient,
  type MemorySearchTarget,
} from "@deployments-ai/memory";
import {
  lambdaModelTokenIssuer,
  makeModelGateway,
  modelGatewayRouteDefaultsFromEnv,
  modelGatewayServiceCredentials,
  type ModelGatewayRouteScope,
  type ModelGatewayServiceTokenContext,
  type ModelUsageLedgerEntry,
} from "@deployments-ai/model-gateway";
import { makeModelUsageRecorder, type ModelUsageScope } from "@deployments-ai/model-usage";
import { Effect } from "effect";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { openSearchTransport } from "./opensearch.ts";
import {
  loadActiveMemoryEmbeddingProfile,
  loadMemoryEmbeddingProfile,
  memoryEmbeddingRouteRequest,
  memoryEmbeddingRouteScope,
  validateMemoryEmbeddingProfile,
  validateMemoryEmbeddingRoute,
} from "./embedding-profile.ts";
import { memorySearchTargetIdentity } from "./target-identity.ts";
const blobs = new S3Client({});
const kms = new KMSClient({});
const queues = new SQSClient({});
const lambdas = new LambdaClient({});
let platformPromise: Promise<MemoryPlatform> | undefined;
const searchProviderCache = new Map<string, Promise<MemorySearchProviderClient>>();
const searchProviderTargetIdentities = new Map<string, string>();
let modelComponentsPromise:
  | Promise<{
      readonly database: ReturnType<typeof runtimeDatabase>;
      readonly gateway: ReturnType<typeof makeModelGateway>;
      readonly usage: ReturnType<typeof makeModelUsageRecorder>;
    }>
  | undefined;
let usageRecorder: ReturnType<typeof makeModelUsageRecorder> | undefined;

/**
 * Run-attributed usage belongs to the run's workspace, which its observability context names. The
 * request scope can name another one: an organization memory a workspace run wrote has none.
 */
function runUsageAttribution(runId: Ulid, observability: ObservabilitySourceContext | undefined) {
  if (!observability) {
    throw new TypeError("Run-attributed model usage requires immutable observability context.");
  }
  return { observability, runId, workspaceId: observability.workspaceId };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function firstRequiredEnv(
  environment: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
) {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${names.join(" or ")} is required.`);
}

export function memoryBlobBucketFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return firstRequiredEnv(environment, [
    "DEPLOYMENTS_AI_MEMORY_BLOB_BUCKET",
    "DEPLOYMENTS_AI_ARTIFACT_BUCKET",
  ]);
}

function memoryEmbeddingDimensionsFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const parsed = Number(environment.DEPLOYMENTS_AI_MEMORY_EMBEDDING_DIMENSIONS?.trim() || "1536");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1_536;
}

function isMissingObject(cause: unknown) {
  if (!cause || typeof cause !== "object") return false;
  const value = cause as Record<string, unknown>;
  return [value.name, value.Code, value.code].some(
    (code) => code === "NoSuchKey" || code === "NoSuchVersion",
  );
}

function legacyBlobBuckets(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment.DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON?.trim();
  if (!value) return [];
  const decoded: unknown = JSON.parse(value);
  if (
    !Array.isArray(decoded) ||
    decoded.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new TypeError(
      "DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON must be a JSON array of non-empty strings.",
    );
  }
  return [...new Set(decoded.map((entry) => entry.trim()))];
}

async function loadMemoryBlob(reference: MemoryBlobReference) {
  const bucket = memoryBlobBucketFromEnv();
  if (reference.bucket !== bucket && !legacyBlobBuckets().includes(reference.bucket)) {
    throw new TypeError("Memory blob reference points outside the configured platform bucket.");
  }
  const result = await blobs.send(
    new GetObjectCommand({
      Bucket: reference.bucket,
      Key: reference.key,
      ...(reference.versionId ? { VersionId: reference.versionId } : {}),
    }),
  );
  if (!result.Body) throw new TypeError("Memory blob object has no body.");
  return result.Body.transformToByteArray();
}

function assertMemoryBlobLocation(
  reference: MemoryBlobReference,
  bucket: string,
  legacyBuckets: readonly string[] = [],
) {
  if (reference.bucket !== bucket && !legacyBuckets.includes(reference.bucket)) {
    throw new TypeError("Memory blob reference points outside the configured platform bucket.");
  }
  if (!reference.key.startsWith("memory/")) {
    throw new TypeError("Memory blob cleanup is restricted to the memory/ prefix.");
  }
}

function memoryBlobContentMatches(reference: MemoryBlobReference, bytes: Uint8Array) {
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  const expectedHash = reference.sha256.toLowerCase().replace(/^sha256:/u, "");
  return bytes.byteLength === reference.byteSize && actualHash === expectedHash;
}

function assertMemoryBlobContent(reference: MemoryBlobReference, bytes: Uint8Array) {
  if (!memoryBlobContentMatches(reference, bytes)) {
    throw new TypeError("Refusing to delete a versionless memory blob that changed.");
  }
}

async function listMemoryBlobVersions(client: S3Client, reference: MemoryBlobReference) {
  const readableVersionIds: string[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: reference.bucket,
        Prefix: reference.key,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }),
    );
    for (const version of page.Versions ?? []) {
      if (version.Key !== reference.key || !version.VersionId) continue;
      readableVersionIds.push(version.VersionId);
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker || versionIdMarker);
  return readableVersionIds;
}

async function deleteMemoryBlobVersions(
  client: S3Client,
  reference: MemoryBlobReference,
  objects: readonly ObjectIdentifier[],
) {
  for (let index = 0; index < objects.length; index += 1_000) {
    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: reference.bucket,
        Delete: { Objects: objects.slice(index, index + 1_000), Quiet: true },
      }),
    );
    if (response.Errors?.length) {
      throw new Error("S3 failed to delete one or more memory blob versions.");
    }
  }
}

export async function deleteMemoryBlobWithClient(
  client: S3Client,
  reference: MemoryBlobReference,
  bucket: string,
  legacyBuckets: readonly string[] = [],
) {
  assertMemoryBlobLocation(reference, bucket, legacyBuckets);
  if (reference.versionId) {
    const current = await client
      .send(
        new GetObjectCommand({
          Bucket: reference.bucket,
          Key: reference.key,
          VersionId: reference.versionId,
        }),
      )
      .catch((cause: unknown) => {
        if (isMissingObject(cause)) return undefined;
        throw cause;
      });
    if (!current) return;
    if (!current.Body) throw new TypeError("Memory blob object has no body.");
    const bytes = await current.Body.transformToByteArray();
    assertMemoryBlobContent(reference, bytes);
    await deleteMemoryBlobVersions(client, reference, [
      { Key: reference.key, VersionId: reference.versionId },
    ]);
    return;
  }
  for (let pass = 0; pass < 10; pass += 1) {
    const versionIds = await listMemoryBlobVersions(client, reference);
    if (versionIds.length === 0) return;
    const matchingVersions: ObjectIdentifier[] = [];
    for (const versionId of versionIds) {
      const version = await client
        .send(
          new GetObjectCommand({
            Bucket: reference.bucket,
            Key: reference.key,
            VersionId: versionId,
          }),
        )
        .catch((cause: unknown) => {
          if (isMissingObject(cause)) return undefined;
          throw cause;
        });
      if (!version) continue;
      if (!version.Body) throw new TypeError("Memory blob object has no body.");
      if (memoryBlobContentMatches(reference, await version.Body.transformToByteArray())) {
        matchingVersions.push({ Key: reference.key, VersionId: versionId });
      }
    }
    if (matchingVersions.length === 0) return;
    await deleteMemoryBlobVersions(client, reference, matchingVersions);
  }
  throw new Error("Memory blob versions did not stabilize during cleanup.");
}

export async function deleteRuntimeMemoryBlob(reference: MemoryBlobReference) {
  return deleteMemoryBlobWithClient(
    blobs,
    reference,
    memoryBlobBucketFromEnv(),
    legacyBlobBuckets(),
  );
}

let documentClient: DynamoDBDocumentClient | undefined;

/** One DynamoDB client, and so one connection pool, for every database a process builds. */
export function runtimeDocumentClient() {
  documentClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return documentClient;
}

export function runtimeDatabase() {
  return makeDynamoDatabase(runtimeDocumentClient(), tableNamesFromEnvironment());
}

/** Tenant context for a service token: the route scope's tenancy, attributed to the memory service. */
export function memoryModelTokenContext(
  scope: ModelGatewayRouteScope | undefined,
): ModelGatewayServiceTokenContext {
  return {
    ...(scope?.agentId ? { agentDefinitionId: scope.agentId } : {}),
    ...(scope?.organizationId ? { organizationId: scope.organizationId } : {}),
    ...(scope?.runId ? { runId: scope.runId } : {}),
    ...(scope?.workspaceId ? { workspaceId: scope.workspaceId } : {}),
  };
}

/** The `memory` service token issuer the memory runtime's gateway calls authenticate with. */
export function memoryModelTokenIssuer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return lambdaModelTokenIssuer(
    lambdas,
    firstRequiredEnv(environment, ["DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER"]),
  );
}

/**
 * Builds a gateway authenticated by the `memory` service token issuer. `context` maps each
 * request to the tenant context its token carries; by default the request's route scope.
 */
export function memoryModelGateway(
  context: (scope: ModelGatewayRouteScope | undefined) => ModelGatewayServiceTokenContext = (
    scope,
  ) => memoryModelTokenContext(scope),
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return makeModelGateway({
    baseUrl: firstRequiredEnv(environment, ["DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL"]),
    credentials: modelGatewayServiceCredentials({
      context: (request) => context(request.scope),
      issue: memoryModelTokenIssuer(environment),
    }),
    ...modelGatewayRouteDefaultsFromEnv(environment),
  });
}

export async function runtimeModelComponents() {
  const pending = (modelComponentsPromise ??= (async () => ({
    database: runtimeDatabase(),
    gateway: memoryModelGateway(),
    usage: runtimeUsageRecorder(),
  }))());
  try {
    return await pending;
  } catch (cause) {
    if (modelComponentsPromise === pending) modelComponentsPromise = undefined;
    throw cause;
  }
}

function runtimeUsageRecorder() {
  return (usageRecorder ??= makeModelUsageRecorder(runtimeDatabase(), makeIdGenerator()));
}

async function sendRuntimeMessage(queueUrlName: string, body: unknown, signal?: AbortSignal) {
  await queues.send(
    new SendMessageCommand({
      MessageBody: JSON.stringify(body),
      QueueUrl: requiredEnv(queueUrlName),
    }),
    signal ? { abortSignal: signal } : undefined,
  );
}

export async function recordRuntimeModelUsage(
  entry: ModelUsageLedgerEntry,
  scope: ModelUsageScope,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    runtimeUsageRecorder().record(entry, scope),
    signal ? { signal } : undefined,
  );
}

export async function persistMemoryRerankUsage(
  operation: () => Promise<unknown>,
  enqueueRetry?: () => Promise<unknown>,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw signal.reason;
  try {
    await operation();
  } catch (usageCause) {
    if (signal?.aborted) throw signal.reason;
    if (enqueueRetry) {
      try {
        await enqueueRetry();
        return;
      } catch (retryCause) {
        throw new MemoryRerankUsagePersistenceError({ retryCause, usageCause });
      }
    }
    throw new MemoryRerankUsagePersistenceError(usageCause);
  }
}

async function rerankMemories(request: MemoryRerankRequest) {
  const { gateway } = await runtimeModelComponents();
  const prompt = memoryRerankPrompt(request.query, request.candidates, request.promptBytes);
  const attributionId =
    request.attribution.kind === "run"
      ? request.attribution.runId
      : request.attribution.operationId;
  const startedAt = Date.now();
  const signal = request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(request.deadlineMs)])
    : AbortSignal.timeout(request.deadlineMs);
  const result = await Effect.runPromise(
    gateway.chatCompletion({
      additionalBody: { response_format: { type: "json_object" }, temperature: 0 },
      maxTokens: request.maxOutputTokens,
      messages: [
        { content: MEMORY_RERANK_SYSTEM_PROMPT, role: "system" },
        { content: prompt, role: "user" },
      ],
      modelCallId: request.modelCallId,
      modelId: process.env.DEPLOYMENTS_AI_MEMORY_RERANK_MODEL?.trim() || "openai/gpt-4o-mini",
      runId: attributionId as Ulid,
      signal,
      scope: {
        organizationId: request.scope.organizationId as Ulid,
        ...(request.attribution.kind === "run" ? { runId: attributionId as Ulid } : {}),
        ...(request.scope.workspaceId ? { workspaceId: request.scope.workspaceId as Ulid } : {}),
      },
    }),
  );
  if (result.usage) {
    const usageScope: Parameters<typeof recordRuntimeModelUsage>[1] = {
      environmentId: request.scope.environmentId as Ulid,
      organizationId: request.scope.organizationId as Ulid,
      projectId: request.scope.projectId as Ulid,
      ...(request.attribution.kind === "run"
        ? runUsageAttribution(request.attribution.runId as Ulid, request.observability)
        : {
            operationId: request.attribution.operationId as Ulid,
            operationType: "memory-rerank",
            workspaceId: request.scope.workspaceId as Ulid | undefined,
          }),
    };
    await persistMemoryRerankUsage(
      () => recordRuntimeModelUsage(result.usage!, usageScope, signal),
      () =>
        sendRuntimeMessage(
          "DEPLOYMENTS_AI_MEMORY_USAGE_QUEUE_URL",
          {
            entry: result.usage,
            scope: usageScope,
            reason: "usage persistence failed",
          },
          signal,
        ),
      signal,
    );
  }
  const expectedIds = request.candidates.map((candidate) => candidate.memory.data.id);
  const scores = parseMemoryRerankCompletion(result.assistantMessage ?? "", expectedIds);
  if (!scores) throw new TypeError("Memory reranker returned an incomplete or invalid score set.");
  return {
    latencyMs: Math.max(0, Date.now() - startedAt),
    model: result.modelId ?? result.route.modelId,
    provider: result.route.provider,
    scores,
  };
}

export function runtimeMemorySearchRegistry(database: DynamoDatabaseService = runtimeDatabase()) {
  return {
    resolve(target: MemorySearchTarget) {
      const identity = memorySearchTargetIdentity(target);
      const registeredIdentity = searchProviderTargetIdentities.get(target.targetId);
      if (registeredIdentity && registeredIdentity !== identity) {
        throw new TypeError(
          `Memory search target ${target.targetId} was reused with a conflicting immutable identity.`,
        );
      }
      const existing = searchProviderCache.get(identity);
      if (existing) return existing;
      searchProviderTargetIdentities.set(target.targetId, identity);
      const pending = (async () => {
        const profile = await loadMemoryEmbeddingProfile(database, target.embeddingProfileId);
        const config = awsNativeTargetLocation(target);
        if (config.embeddingDimensions !== profile.data.dimensions) {
          throw new TypeError("AWS-native target dimensions do not match its embedding profile.");
        }
        return makeAwsNativeMemoryProvider({
          config,
          openSearch: openSearchTransport(config),
          target,
        });
      })();
      searchProviderCache.set(identity, pending);
      pending.catch(() => {
        if (searchProviderCache.get(identity) === pending) searchProviderCache.delete(identity);
        if (searchProviderTargetIdentities.get(target.targetId) === identity) {
          searchProviderTargetIdentities.delete(target.targetId);
        }
      });
      return pending;
    },
  };
}

function runtimePageCursorCodec() {
  const localKeyHex = process.env.DEPLOYMENTS_AI_MEMORY_CURSOR_KEY_HEX?.trim();
  if (localKeyHex) {
    if (!/^[0-9a-f]{64}$/iu.test(localKeyHex)) {
      throw new TypeError(
        "DEPLOYMENTS_AI_MEMORY_CURSOR_KEY_HEX must contain 32 hexadecimal bytes.",
      );
    }
    const key = Buffer.from(localKeyHex, "hex");
    return {
      open: async (ciphertext: string) => {
        try {
          const bytes = Buffer.from(ciphertext, "base64url");
          if (bytes.byteLength < 29) throw new Error("Invalid encrypted cursor.");
          const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
          decipher.setAuthTag(bytes.subarray(12, 28));
          return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
            "utf8",
          );
        } catch (cause) {
          throw new InvalidMemoryPageCursorError("Invalid encrypted cursor.", { cause });
        }
      },
      seal: async (plaintext: string) => {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
      },
    };
  }
  const keyArn = process.env.DEPLOYMENTS_AI_MEMORY_CURSOR_KMS_KEY_ARN?.trim();
  if (!keyArn) return undefined;
  const encryptionContext = { purpose: "memory-page-cursor" };
  return {
    open: async (ciphertext: string) => {
      const result = await kms
        .send(
          new DecryptCommand({
            CiphertextBlob: Buffer.from(ciphertext, "base64url"),
            EncryptionContext: encryptionContext,
            KeyId: keyArn,
          }),
        )
        .catch((cause: unknown) => {
          if (cause && typeof cause === "object" && "name" in cause) {
            if (String(cause.name) === "InvalidCiphertextException") {
              throw new InvalidMemoryPageCursorError("Invalid encrypted cursor.", { cause });
            }
          }
          throw cause;
        });
      if (!result.Plaintext) throw new Error("KMS returned no cursor plaintext.");
      return Buffer.from(result.Plaintext).toString("utf8");
    },
    seal: async (plaintext: string) => {
      const result = await kms.send(
        new EncryptCommand({
          EncryptionContext: encryptionContext,
          KeyId: keyArn,
          Plaintext: Buffer.from(plaintext),
        }),
      );
      if (!result.CiphertextBlob) throw new TypeError("KMS returned no cursor ciphertext.");
      return Buffer.from(result.CiphertextBlob).toString("base64url");
    },
  };
}

export async function runtimeMemoryPlatform() {
  const pending = (platformPromise ??= (async () => {
    const database = runtimeDatabase();
    const embeddingDimensions = memoryEmbeddingDimensionsFromEnv();
    const searchPlacementResolver = makeMemorySearchPlacementResolver(
      database,
      runtimeMemorySearchRegistry(database),
    );
    const searchRoutingResolver = makeMemorySearchRoutingResolver(database);
    const pageCursorCodec = runtimePageCursorCodec();
    return makeMemoryPlatform({
      database,
      deleteBlob: deleteRuntimeMemoryBlob,
      embedding: async (request) => {
        const { gateway, usage } = await runtimeModelComponents();
        const embeddingProfile = request.embeddingProfileId
          ? await loadActiveMemoryEmbeddingProfile(database, request.embeddingProfileId)
          : undefined;
        const attributionId =
          request.attribution.kind === "run"
            ? request.attribution.runId
            : request.attribution.operationId;
        const routeScope = memoryEmbeddingRouteScope(request.scope.organizationId);
        const modelId =
          embeddingProfile?.data.gatewayModel ??
          (process.env.DEPLOYMENTS_AI_MEMORY_EMBEDDING_MODEL?.trim() ||
            "openai/text-embedding-3-small");
        const routeRequest = embeddingProfile
          ? memoryEmbeddingRouteRequest(embeddingProfile, routeScope)
          : undefined;
        const resolvedRoute = routeRequest
          ? await Effect.runPromise(gateway.resolveRoute(routeRequest))
          : undefined;
        if (embeddingProfile && resolvedRoute) {
          validateMemoryEmbeddingRoute(embeddingProfile, resolvedRoute);
        }
        const result = await Effect.runPromise(
          gateway.embedding({
            dimensions: embeddingProfile?.data.dimensions ?? embeddingDimensions,
            input: request.content,
            modelCallId: request.modelCallId,
            modelId,
            ...(routeRequest?.fallbackModelIds
              ? { fallbackModelIds: routeRequest.fallbackModelIds }
              : {}),
            ...(resolvedRoute ? { resolvedRoute } : {}),
            ...(request.providerSignal ? { providerSignal: request.providerSignal } : {}),
            runId: attributionId,
            ...(request.signal ? { signal: request.signal } : {}),
            scope: routeScope,
          }),
        );
        if (result.usage) {
          await Effect.runPromise(
            usage.record(result.usage, {
              environmentId: request.scope.environmentId,
              organizationId: request.scope.organizationId,
              projectId: request.scope.projectId,
              ...(request.attribution.kind === "run"
                ? runUsageAttribution(request.attribution.runId, request.observability)
                : {
                    operationId: request.attribution.operationId,
                    operationType: request.attribution.operationType,
                    workspaceId: request.scope.workspaceId,
                  }),
            }),
          );
        }
        return {
          embedding:
            embeddingProfile && resolvedRoute
              ? validateMemoryEmbeddingProfile(embeddingProfile, resolvedRoute, result)
              : result.embedding,
          ...(request.embeddingProfileId ? { embeddingProfileId: request.embeddingProfileId } : {}),
          model: result.modelId,
          provider: result.provider,
        };
      },
      loadBlob: loadMemoryBlob,
      ...(pageCursorCodec ? { pageCursorCodec } : {}),
      rerank: rerankMemories,
      searchPlacementResolver,
      searchRoutingResolver,
    });
  })());
  try {
    return await pending;
  } catch (cause) {
    if (platformPromise === pending) platformPromise = undefined;
    throw cause;
  }
}
