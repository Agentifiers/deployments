import { GetObjectCommand } from "@aws-sdk/client-s3";
import { DOCUMENT_TEXT_EXTRACTOR, type DocumentMediaType } from "@deployments-ai/agent-manifest";
import { modelGatewayGenerationPort } from "@deployments-ai/agent-runtime";
import {
  ArtifactRecord,
  INGRESS_ATTACHMENT_OBJECT_NAME,
  MessageRecord,
  RunRecord,
  customerArtifactStorageKey,
  dataBoundaryOf,
  ingressAttachmentObjectKey,
  inputFileTextKey,
  withCanonicalRecordKeys,
  type ArtifactInputFile,
  type ArtifactOwner,
  type DynamoDatabaseService,
  type InputFileOmission,
  type RunInitiatingCaller,
  type Ulid,
} from "@deployments-ai/db";
import type {
  ModelGatewayChatCompletionRequest,
  ModelGatewayService,
  ModelGatewayToolCall,
} from "@deployments-ai/model-gateway";
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { workerDependencies } from "./agent-run.fixture.ts";
import { createRuntimeAttachmentBuiltinExecutors } from "./attachment-runtime-tools.ts";
import { createS3RunInputArtifactLoader } from "./input-artifacts.ts";
import { createRuntimeToolService } from "./runtime-tool-authorization.ts";
import type { AgentRunWorkerDependencies, MessageRecordValue, RunRecordValue } from "./types.ts";

export const ARTIFACT_BUCKET = "private-artifacts";

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly versionId: string;
}

type StoredObjects = readonly (readonly [string, StoredObject])[];

export interface GatewayReply {
  readonly assistantMessage: string;
  readonly finishReason?: string;
  readonly toolCalls?: readonly ModelGatewayToolCall[];
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inputFile(
  run: RunRecordValue,
  file: {
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly id: Ulid;
    readonly input: ArtifactInputFile;
    readonly name: string;
    readonly owner: ArtifactOwner;
    readonly retentionExpiresAt?: string;
  },
) {
  const ingress = file.owner.type === "ingress";
  const key = ingress
    ? ingressAttachmentObjectKey(run.data, file.id, sha256(file.bytes))
    : customerArtifactStorageKey(run.data, file.id, sha256(file.bytes), file.name);
  const artifact = Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: run.data.createdAt,
        environmentId: run.data.environmentId,
        id: file.id,
        input: file.input,
        name: file.name,
        organizationId: run.data.organizationId,
        owner: file.owner,
        projectId: run.data.projectId,
        ...(file.retentionExpiresAt ? { retentionExpiresAt: file.retentionExpiresAt } : {}),
        status: "available" as const,
        storage: {
          bucket: ARTIFACT_BUCKET,
          byteSize: file.bytes.byteLength,
          contentType: file.contentType,
          fileName: ingress ? INGRESS_ATTACHMENT_OBJECT_NAME : file.name,
          key,
          sha256: sha256(file.bytes),
          versionId: "v1",
        },
        threadId: run.data.threadId,
        type: "input",
        updatedAt: run.data.createdAt,
        version: 0,
        visibility: "private" as const,
      },
      itemType: "artifact" as const,
      ...(file.retentionExpiresAt
        ? { ttl: Math.floor(Date.parse(file.retentionExpiresAt) / 1000) }
        : {}),
    }),
  );
  const objects: StoredObjects = [
    [key, { bytes: file.bytes, contentType: file.contentType, versionId: "v1" }],
  ];
  return { artifact, objects };
}

export function pngFile(
  run: RunRecordValue,
  file: {
    readonly bytes: Uint8Array;
    readonly id: Ulid;
    readonly name: string;
    readonly owner: ArtifactOwner;
  },
) {
  return inputFile(run, {
    ...file,
    contentType: "image/png",
    input: { kind: "image", mediaType: "image/png" },
  });
}

export function textDocument(
  run: RunRecordValue,
  file: {
    readonly id: Ulid;
    readonly mediaType: DocumentMediaType;
    readonly name: string;
    readonly owner: ArtifactOwner;
    readonly retentionExpiresAt?: string;
    readonly summary: string;
    readonly text: string;
  },
) {
  const bytes = new TextEncoder().encode(file.text);
  const { artifact, objects } = inputFile(run, {
    bytes,
    contentType: file.mediaType,
    id: file.id,
    input: {
      kind: "document",
      mediaType: file.mediaType,
      summary: file.summary,
      text: {
        byteSize: bytes.byteLength,
        extractor: DOCUMENT_TEXT_EXTRACTOR,
        sha256: sha256(bytes),
        truncated: false,
        versionId: "text-v1",
      },
    },
    name: file.name,
    owner: file.owner,
    ...(file.retentionExpiresAt ? { retentionExpiresAt: file.retentionExpiresAt } : {}),
  });
  const textKey = inputFileTextKey(run.data, file.id, sha256(bytes));
  const text: StoredObjects = [
    [textKey, { bytes, contentType: "text/plain; charset=utf-8", versionId: "text-v1" }],
  ];
  return { artifact, objects: [...objects, ...text], textKey };
}

export function inputTurn(
  turn: { readonly run: RunRecordValue; readonly userMessage: MessageRecordValue },
  caller: RunInitiatingCaller,
  files: {
    readonly inputArtifacts?: readonly [Ulid, ...Ulid[]];
    readonly inputOmissions?: readonly InputFileOmission[];
  },
) {
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...turn.run.data,
        initiatingCaller: caller,
        ...(files.inputArtifacts
          ? {
              inputArtifacts: files.inputArtifacts,
              userMessageId: turn.userMessage.data.id,
              userMessageSequence: turn.userMessage.data.sequence,
            }
          : {}),
      },
      itemType: "run" as const,
    }),
  );
  const trigger = Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: { ...turn.userMessage.data, ...files },
      itemType: "message" as const,
    }),
  );
  return { run, trigger };
}

export function inputFilesHarness(
  database: DynamoDatabaseService,
  objects: StoredObjects,
  reply: (request: ModelGatewayChatCompletionRequest, index: number) => GatewayReply = () => ({
    assistantMessage: "The error says the disk is full.",
  }),
) {
  const captured: ModelGatewayChatCompletionRequest[] = [];
  const reads: { readonly key: string; readonly range?: string }[] = [];
  const store = new Map(objects);
  const s3 = {
    send: async (command: unknown) => {
      if (!(command instanceof GetObjectCommand)) throw new Error("Unexpected S3 operation.");
      const { Key = "", Range, VersionId } = command.input;
      reads.push(Range ? { key: Key, range: Range } : { key: Key });
      const object = store.get(Key);
      if (!object || object.versionId !== VersionId) throw new Error("NoSuchVersion");
      const range = Range?.match(/^bytes=(\d+)-(\d+)$/u);
      const bytes = range
        ? object.bytes.subarray(Number(range[1]), Number(range[2]) + 1)
        : object.bytes;
      return {
        Body: (async function* () {
          yield bytes;
        })(),
        ContentLength: bytes.byteLength,
        ContentType: object.contentType,
        VersionId: object.versionId,
      };
    },
  };
  const gateway = {
    chatCompletion: (request: ModelGatewayChatCompletionRequest) => {
      const index = captured.push(request) - 1;
      return Effect.succeed({
        ...reply(request, index),
        body: {},
        modelCallId: request.modelCallId,
        route: {},
      } as never);
    },
  } as unknown as ModelGatewayService;
  const { dependencies } = workerDependencies(database);
  const withFiles: AgentRunWorkerDependencies = {
    ...dependencies,
    createExecutionInputArtifactLoader: () =>
      createS3RunInputArtifactLoader({
        bucket: ARTIFACT_BUCKET,
        client: s3 as never,
        database,
      }),
    runtime: {
      ...createRuntimeToolService({
        dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
        egressAllowlists: { read: async () => [] },
        builtinExecutors: createRuntimeAttachmentBuiltinExecutors({
          bucket: ARTIFACT_BUCKET,
          database,
          s3: s3 as never,
        }),
        generateId: dependencies.generateId,
        resolveAuthorizationContext: async () => {
          throw new Error("Platform built-in tools never resolve provider authorization.");
        },
        resolveProviderCredential: async () => {
          throw new Error("Platform built-in tools never load provider credentials.");
        },
      }),
      generateAssistantMessage: modelGatewayGenerationPort(gateway),
      recordArtifact: async () => undefined,
    },
  };
  return { captured, dependencies: withFiles, reads };
}

export function modelVisibleToolResults(request: ModelGatewayChatCompletionRequest | undefined) {
  return (request?.messages ?? []).flatMap((message) =>
    message.role === "tool" && typeof message.content === "string"
      ? [JSON.parse(message.content.slice(message.content.indexOf("\n") + 1))]
      : [],
  );
}

export function readCall(callId: string, input: Readonly<Record<string, unknown>>) {
  return { arguments: input, id: callId, name: "runtime_tool_0" };
}

export function readThenAnswer(toolCalls: NonNullable<GatewayReply["toolCalls"]>) {
  return (_request: unknown, index: number): GatewayReply =>
    index === 0
      ? { assistantMessage: "", finishReason: "tool_calls", toolCalls }
      : { assistantMessage: "Read it." };
}
