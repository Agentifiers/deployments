import { describe, expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import type {
  ChannelAttachment,
  ChannelProvider,
  ExternalAgentChannel,
} from "@deployments-ai/channel-adapters";
import { endUserKeyDeriver } from "@deployments-ai/conversations";
import { makeTenantRoleSessions, type TenantRoleSts } from "@deployments-ai/credential-vault";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  ChannelBindingRecord,
  evaluateRunInputArtifacts,
  makeChannelIngressBurstPersistence,
  makeDynamoDatabase,
  OrganizationRecord,
  Ulid,
  withCanonicalRecordKeys,
  type ArtifactOwner,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import type { ExtractionRequest, FileTextExtractor } from "@deployments-ai/file-text";
import { makeS3IngressAttachmentObjectStore } from "@deployments-ai/ingress-media";
import type { ExecutePinnedHttpRequestOptions } from "@deployments-ai/net-security";
import { Schema } from "effect";
import type { ChannelBinding } from "./channel-credentials.ts";
import { channelAttachmentCandidates } from "./ingress-attachments.ts";
import {
  processChannelIngressQueueCommand,
  type ChannelIngressQueueConsumerDependencies,
  type ChannelIngressQueueOutcome,
} from "./ingress-consumer.ts";
import { channelIngressQueueDependencies } from "./ingress-consumer-main.ts";
import {
  channelIngressFlushQueueMessage,
  decodeChannelIngressQueueMessage,
  type ChannelIngressQueueMessageV1,
} from "./ingress.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);
const organizationId = id("1");
const projectId = id("2");
const environmentId = id("3");
const bindingId = id("4");
const definitionId = id("5");
const deploymentId = id("6");
const releaseId = id("7");
const ARTIFACT_BUCKET = "platform-artifacts";
const ARTIFACT_KMS_KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/artifacts";
const CAPTURE_ROLE_ARN = "arn:aws:iam::123456789012:role/agent-ingress-attachment-capture";
const STARTED_AT = Date.parse("2026-10-07T12:00:00.000Z");
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG = Uint8Array.from([...PNG_SIGNATURE, ...new TextEncoder().encode("whiteboard photo")]);
const PNG_SHA256 = "18b9250e2b0d7d0a002fa16455ad43e3fa1919e37792d4e71fff99b48599fe8b";
const TELEGRAM_TOKEN = "123456:telegram-secret";

interface ProviderCase {
  readonly artifactName: string;
  readonly attachment: ChannelAttachment;
  readonly channel: "slack" | "teams" | "telegram";
  readonly credentials: Readonly<Record<string, string>>;
  readonly externalWorkspaceId: string;
  readonly fileUrl: string;
  readonly provider: "slack_edge" | "teams_bot_framework" | "telegram";
  readonly lookups: Readonly<Record<string, () => Response>>;
}

const SLACK_FILE_URL = "https://files.slack.com/files-pri/T0001-F0001/download/whiteboard.png";
const TEAMS_CONTENT_URL =
  "https://smba.trafficmanager.net/amer/v3/attachments/0-cus-d1-abc/views/original";
const TELEGRAM_FILE_URL = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/photos/file_7.png`;

const PROVIDERS: readonly ProviderCase[] = [
  {
    artifactName: "whiteboard.png",
    attachment: {
      byteSize: PNG.byteLength,
      contentType: "image/png",
      fileName: "whiteboard.png",
      kind: "image",
      providerAttachmentId: "F0001",
      url: SLACK_FILE_URL,
    },
    channel: "slack",
    credentials: { botToken: "xoxb-slack-bot" },
    externalWorkspaceId: "T0001",
    fileUrl: SLACK_FILE_URL,
    lookups: {},
    provider: "slack_edge",
  },
  {
    artifactName: "whiteboard.png",
    attachment: {
      contentType: "image/png",
      fileName: "whiteboard.png",
      kind: "image",
      url: TEAMS_CONTENT_URL,
    },
    channel: "teams",
    credentials: {
      appId: "00000000-0000-4000-8000-000000000001",
      appPassword: "teams-app-password",
      appTenantId: "11111111-2222-4333-8444-555555555555",
    },
    externalWorkspaceId: "bot-1",
    fileUrl: TEAMS_CONTENT_URL,
    lookups: {},
    provider: "teams_bot_framework",
  },
  {
    artifactName: "attachment-1",
    attachment: { byteSize: PNG.byteLength, kind: "image", providerAttachmentId: "AgADphoto" },
    channel: "telegram",
    credentials: { botToken: TELEGRAM_TOKEN },
    externalWorkspaceId: "bot-1",
    fileUrl: TELEGRAM_FILE_URL,
    lookups: {
      [`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=AgADphoto`]: () =>
        Response.json({ ok: true, result: { file_path: "photos/file_7.png" } }),
    },
    provider: "telegram",
  },
];

function controlRecords(provider: ProviderCase, ingressAttachments: "attach" | undefined) {
  const createdAt = new Date(STARTED_AT).toISOString();
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "support.whiteboard", name: "Whiteboard Helper", version: "1.0.0" },
    spec: {
      instructions: "Describe what people share.",
      model: { id: "openrouter/qwen/qwen3.7-plus" },
      ...(ingressAttachments ? { runtime: { ingressAttachments } } : {}),
      sandbox: { mode: "none" },
    },
  });
  return [
    Schema.decodeUnknownSync(OrganizationRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt,
          id: organizationId,
          name: "Acme",
          slug: "acme",
          status: "active",
          updatedAt: createdAt,
          version: 1,
        },
        itemType: "organization" as const,
      }),
    ),
    Schema.decodeUnknownSync(ChannelBindingRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDefinitionId: definitionId,
          agentDeploymentId: deploymentId,
          channel: provider.channel,
          createdAt,
          credentialRef: { credentialId: id("8"), generation: 0, store: "dynamodb-kms" },
          environmentId,
          externalChannelId: "channel-1",
          externalWorkspaceId: provider.externalWorkspaceId,
          id: bindingId,
          organizationId,
          projectId,
          provider: provider.provider,
          status: "active",
          updatedAt: createdAt,
          version: 0,
        },
        itemType: "channel-binding" as const,
      }),
    ),
    Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDefinitionId: definitionId,
          agentReleaseId: releaseId,
          createdAt,
          currentState: "ready",
          desiredState: "running",
          environmentId,
          id: deploymentId,
          organizationId,
          projectId,
          updatedAt: createdAt,
          version: 0,
        },
        itemType: "agent-deployment" as const,
      }),
    ),
    Schema.decodeUnknownSync(AgentReleaseRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDefinitionId: definitionId,
          contentHash: agentManifestContentHash(manifest),
          createdAt,
          createdByPrincipalId: id("9"),
          environmentId,
          id: releaseId,
          manifest,
          organizationId,
          projectId,
          releaseNumber: 1,
          status: "active",
          version: 0,
        },
        itemType: "agent-release" as const,
      }),
    ),
  ];
}

const inputField = (input: object, name: string): unknown =>
  name in input ? Reflect.get(input, name) : undefined;

function memoryArtifactBucket() {
  const objects = new Map<
    string,
    {
      readonly bucket: unknown;
      readonly bytes: Uint8Array;
      readonly contentType: unknown;
      readonly kmsKeyId: unknown;
      readonly versionId: string;
    }
  >();
  const s3 = new S3Client({
    credentials: { accessKeyId: "capture-session", secretAccessKey: "capture-secret" },
    region: "us-east-1",
  });
  s3.middlewareStack.add(
    (_next, context) => async (args) => {
      if (context.commandName !== "PutObjectCommand") {
        throw new Error(`Unexpected ${String(context.commandName)} against the artifact bucket.`);
      }
      const input: object = args.input;
      const key = String(inputField(input, "Key"));
      const body = inputField(input, "Body");
      if (!(body instanceof Uint8Array)) throw new Error("Expected a byte body.");
      if (objects.has(key) && inputField(input, "IfNoneMatch") === "*") {
        throw new Error("An artifact object was written twice.");
      }
      const versionId = `version-${String(objects.size + 1)}`;
      objects.set(key, {
        bucket: inputField(input, "Bucket"),
        bytes: body,
        contentType: inputField(input, "ContentType"),
        kmsKeyId: inputField(input, "SSEKMSKeyId"),
        versionId,
      });
      return {
        output: {
          $metadata: { httpStatusCode: 200 },
          ETag: `"etag-${versionId}"`,
          VersionId: versionId,
        },
        response: {},
      };
    },
    { step: "initialize" },
  );
  return {
    objects,
    store: makeS3IngressAttachmentObjectStore({ kmsKeyArn: ARTIFACT_KMS_KEY_ARN, s3 }),
  };
}

const inputObjectKey = (artifactId: string) =>
  `artifacts/organizations/${organizationId}/projects/${projectId}/environments/${environmentId}/customer/${artifactId}/${PNG_SHA256}/@input`;

function recordingExtractor() {
  const requests: ExtractionRequest[] = [];
  const extractor: FileTextExtractor = {
    extract: async (request) => {
      requests.push(request);
      throw new Error("An image must never reach document extraction.");
    },
  };
  return { extractor, requests };
}

function fakeCaptureSts() {
  const assumed: AssumeRoleCommand["input"][] = [];
  const sts: TenantRoleSts = {
    send: async (command) => {
      assumed.push(command.input);
      return {
        $metadata: {},
        Credentials: {
          AccessKeyId: `capture-session-${assumed.length}`,
          Expiration: new Date(Date.now() + 900_000),
          SecretAccessKey: "capture-secret",
          SessionToken: "capture-token",
        },
      };
    },
  };
  return { assumed, sts };
}

function fakeProviderTransport(provider: ProviderCase, fileStatus: number) {
  const requests: string[] = [];
  const tokenRequests: string[] = [];
  const transport = {
    botTokenFetch: Object.assign(
      async (input: string | URL | Request) => {
        tokenRequests.push(input instanceof Request ? input.url : String(input));
        return Response.json({ access_token: "teams-bot-token", expires_in: 3_599 });
      },
      { preconnect: fetch.preconnect },
    ),
    dnsLookup: () => [{ address: "93.184.216.34", family: 4 as const }],
    pinnedRequest: async (request: ExecutePinnedHttpRequestOptions) => {
      const url = String(request.url);
      requests.push(url);
      const lookup = provider.lookups[url];
      if (lookup) return lookup();
      if (url !== provider.fileUrl) return new Response(null, { status: 404 });
      return fileStatus === 200
        ? new Response(PNG, { headers: { "content-length": String(PNG.byteLength) } })
        : new Response(null, { status: fileStatus });
    },
  };
  return { requests, tokenRequests, transport };
}

function sourceMessage(
  route: {
    readonly channel: ExternalAgentChannel;
    readonly externalWorkspaceId?: string;
    readonly provider: ChannelProvider;
  },
  externalMessageId: string,
  attachments: readonly ChannelAttachment[],
): ChannelIngressQueueMessageV1 {
  return {
    bindingId,
    environmentId,
    ingress: {
      attachments,
      channel: route.channel,
      content: "What does the whiteboard say?",
      externalChannelId: "channel-1",
      externalMessageId,
      externalThreadKey: "thread-1",
      externalWorkspaceId: route.externalWorkspaceId,
      provider: route.provider,
      sender: { displayName: "Dana", id: "sender-1" },
    },
    organizationId,
    projectId,
    receivedAt: new Date(STARTED_AT).toISOString(),
    type: "channel.ingress",
    version: 1,
  };
}

function channelFlushHarness(
  provider: ProviderCase,
  options: {
    readonly attachments?: readonly ChannelAttachment[];
    readonly fileStatus?: number;
    readonly ingressAttachments?: "attach";
  } = {},
) {
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  for (const record of controlRecords(provider, options.ingressAttachments)) {
    dynamo.put("control", record);
  }
  let clock = STARTED_AT;
  let generated = 0;
  const flushes: unknown[] = [];
  const queuedRunIds: Ulid[] = [];
  const credentialReads: Ulid[] = [];
  const bucket = memoryArtifactBucket();
  const capture = fakeCaptureSts();
  const extraction = recordingExtractor();
  const providerApi = fakeProviderTransport(provider, options.fileStatus ?? 200);
  const dependencies = channelIngressQueueDependencies({
    attachments: {
      artifactBucket: ARTIFACT_BUCKET,
      extractor: extraction.extractor,
      openObjectStore: makeTenantRoleSessions({
        open: () => bucket.store,
        roleArn: CAPTURE_ROLE_ARN,
        sessionName: "channel-attachment-capture",
        sts: capture.sts,
      }),
      readCredentialValues: async (binding: ChannelBinding) => {
        credentialReads.push(binding.data.id);
        return provider.credentials;
      },
      transport: providerApi.transport,
    },
    database,
    endUserSubjects: endUserKeyDeriver("channel-ingress-test-subject-key-0123456789"),
    enqueueFlush: async (flush) => {
      flushes.push(JSON.parse(JSON.stringify(channelIngressFlushQueueMessage(flush))));
    },
    enqueueRun: async ({ message }) => {
      queuedRunIds.push(message.runId);
    },
    generateId: async () => id(`A${String((generated += 1)).padStart(3, "0")}`),
  });
  const burstPersistence = makeChannelIngressBurstPersistence({
    database,
    now: () => new Date(clock),
  });
  let crashBeforeSettling = false;
  const runtime: ChannelIngressQueueConsumerDependencies = {
    ...dependencies,
    burstPersistence: {
      ...burstPersistence,
      complete: async (flush) => {
        if (crashBeforeSettling) {
          crashBeforeSettling = false;
          throw new Error("The flush Lambda timed out before settling the burst.");
        }
        return burstPersistence.complete(flush);
      },
    },
  };
  const message = sourceMessage(
    provider,
    "source-message-1",
    options.attachments ?? [provider.attachment],
  );
  return {
    bucket,
    capture,
    credentialReads,
    database,
    extraction,
    providerApi,
    queuedRunIds,
    async flush() {
      clock += 60_000;
      return processChannelIngressQueueCommand(flushes.at(-1), runtime);
    },
    async receive() {
      await processChannelIngressQueueCommand(message, runtime);
    },
    crashNextFlushBeforeSettling() {
      crashBeforeSettling = true;
    },
  };
}

function submitted(outcome: ChannelIngressQueueOutcome) {
  if (outcome.kind !== "submitted") throw new Error(`Expected a submission, got ${outcome.kind}.`);
  return outcome;
}

const ingressOwner: ArtifactOwner = {
  sourceId: bindingId,
  sourceKind: "channel-binding",
  type: "ingress",
};

describe("channel flush attachment capture", () => {
  for (const provider of PROVIDERS) {
    describe(provider.provider, () => {
      test("an opted-in release sends the image to the run as a stored input artifact", async () => {
        const harness = channelFlushHarness(provider, { ingressAttachments: "attach" });
        await harness.receive();
        const { omittedAttachments, result, skippedAttachments } = submitted(await harness.flush());

        const artifactIds = result.run.data.inputArtifacts ?? [];
        expect(artifactIds).toHaveLength(1);
        expect(result.created).toBe(true);
        expect(result.created && result.omittedInputArtifacts).toEqual([]);
        expect({ omittedAttachments, skippedAttachments }).toEqual({
          omittedAttachments: [],
          skippedAttachments: [],
        });
        const verdicts = await evaluateRunInputArtifacts(harness.database, {
          artifactIds,
          environmentId,
          now: new Date(),
          organizationId,
          owner: ingressOwner,
          projectId,
          threadId: result.thread.data.id,
        });
        const [verdict] = verdicts;
        if (verdict?.kind !== "available") throw new Error("The input artifact is not available.");
        expect(verdict.file).toEqual({ kind: "image", mediaType: "image/png" });
        expect(verdict.record.data).toMatchObject({
          id: artifactIds[0],
          input: { kind: "image", mediaType: "image/png" },
          name: provider.artifactName,
          owner: ingressOwner,
          status: "available",
          threadId: result.thread.data.id,
          type: "input",
          visibility: "private",
        });
        const { storage } = verdict.record.data;
        expect(storage).toMatchObject({
          bucket: ARTIFACT_BUCKET,
          byteSize: PNG.byteLength,
          contentType: "application/octet-stream",
          key: inputObjectKey(verdict.record.data.id),
        });
        const stored = harness.bucket.objects.get(inputObjectKey(verdict.record.data.id));
        expect(stored?.bytes).toEqual(PNG);
        expect(stored).toMatchObject({
          bucket: ARTIFACT_BUCKET,
          contentType: "application/octet-stream",
          kmsKeyId: ARTIFACT_KMS_KEY_ARN,
          versionId: storage.versionId,
        });
        expect(harness.extraction.requests).toEqual([]);
        expect(harness.providerApi.requests.filter((url) => url === provider.fileUrl)).toEqual([
          provider.fileUrl,
        ]);
      });

      test("re-processing the same flush reconciles to the same run and artifacts", async () => {
        const harness = channelFlushHarness(provider, { ingressAttachments: "attach" });
        await harness.receive();
        harness.crashNextFlushBeforeSettling();
        const crash = await harness.flush().catch((error: unknown) => error);
        expect(crash).toMatchObject({
          message: "The flush Lambda timed out before settling the burst.",
        });

        const { omittedAttachments, result } = submitted(await harness.flush());

        expect(result.created).toBe(false);
        expect(result.run.data.inputArtifacts).toHaveLength(1);
        expect([...harness.bucket.objects.keys()]).toEqual(
          (result.run.data.inputArtifacts ?? []).map(inputObjectKey),
        );
        expect(harness.queuedRunIds).toEqual([result.run.data.id, result.run.data.id]);
        expect(omittedAttachments).toEqual([]);
        expect(harness.providerApi.requests.filter((url) => url === provider.fileUrl)).toEqual([
          provider.fileUrl,
        ]);
      });

      test("a release without the opt-in fetches nothing and the run carries no media", async () => {
        const harness = channelFlushHarness(provider);
        await harness.receive();
        const { omittedAttachments, result } = submitted(await harness.flush());

        expect(result.created && result.omittedInputArtifacts.map(({ reason }) => reason)).toEqual([
          "ingress_attachments_disabled",
        ]);
        expect(result.run.data.inputArtifacts).toBeUndefined();
        expect(omittedAttachments).toEqual([]);
        expect(harness.credentialReads).toEqual([]);
        expect(harness.providerApi.requests).toEqual([]);
        expect(harness.providerApi.tokenRequests).toEqual([]);
        expect(harness.bucket.objects.size).toBe(0);
        expect(harness.capture.assumed).toEqual([]);
      });

      test("a provider 503 leaves the attachment out and the turn still runs", async () => {
        const harness = channelFlushHarness(provider, {
          fileStatus: 503,
          ingressAttachments: "attach",
        });
        await harness.receive();
        const { omittedAttachments, result } = submitted(await harness.flush());

        expect(result.created).toBe(true);
        expect(result.run.data.status).toBe("queued");
        expect(result.run.data.inputArtifacts).toBeUndefined();
        expect(omittedAttachments.map(({ reason }) => reason)).toEqual(["unavailable"]);
        expect(result.created && result.omittedInputArtifacts).toEqual([
          { artifactId: omittedAttachments[0]!.artifactId, reason: "input_artifact_unavailable" },
        ]);
        expect(harness.bucket.objects.size).toBe(0);
        expect(harness.capture.assumed).toEqual([]);
      });

      test("a provider refusal is reported as unreadable, not as an outage", async () => {
        const harness = channelFlushHarness(provider, {
          fileStatus: 403,
          ingressAttachments: "attach",
        });
        await harness.receive();
        const { omittedAttachments, result } = submitted(await harness.flush());

        expect(result.created).toBe(true);
        expect(result.run.data.inputArtifacts).toBeUndefined();
        expect(omittedAttachments.map(({ reason }) => reason)).toEqual(["unreadable"]);
      });
    });
  }

  test("stores attachments through a capture session tagged with the binding's tenant", async () => {
    const harness = channelFlushHarness(PROVIDERS[0]!, { ingressAttachments: "attach" });
    await harness.receive();
    const { result } = submitted(await harness.flush());

    expect(result.run.data.inputArtifacts).toHaveLength(1);
    expect(harness.capture.assumed).toEqual([
      {
        DurationSeconds: 900,
        RoleArn: CAPTURE_ROLE_ARN,
        RoleSessionName: "channel-attachment-capture",
        Tags: [
          { Key: "environmentId", Value: "01ARZ3NDEKTSV4RRFFQ69G0003" },
          { Key: "organizationId", Value: "01ARZ3NDEKTSV4RRFFQ69G0001" },
          { Key: "projectId", Value: "01ARZ3NDEKTSV4RRFFQ69G0002" },
        ],
      },
    ]);
  });

  test("files the turn cannot take are never downloaded, and a redelivered flush names them to the same run", async () => {
    const slack = PROVIDERS[0]!;
    const harness = channelFlushHarness(slack, {
      attachments: [
        {
          contentType: "application/vnd.ms-excel",
          fileName: "budget.xls",
          kind: "other",
          url: "https://files.slack.com/files-pri/T0001-F0003/download/budget.xls",
        },
        {
          contentType: "video/quicktime",
          fileName: "clip.mov",
          kind: "video",
          url: "https://files.slack.com/files-pri/T0001-F0004/download/clip.mov",
        },
        slack.attachment,
      ],
      ingressAttachments: "attach",
    });
    await harness.receive();
    harness.crashNextFlushBeforeSettling();
    const crash = await harness.flush().catch((error: unknown) => error);
    expect(crash).toMatchObject({
      message: "The flush Lambda timed out before settling the burst.",
    });

    const { omittedAttachments, result, skippedAttachments } = submitted(await harness.flush());

    expect(skippedAttachments).toEqual([
      {
        identity: { externalMessageId: "source-message-1", ordinal: 0, type: "channel-attachment" },
        name: "budget.xls",
        reason: "legacy_office_format",
      },
      {
        identity: { externalMessageId: "source-message-1", ordinal: 1, type: "channel-attachment" },
        name: "clip.mov",
        reason: "unsupported_type",
      },
    ]);
    expect(omittedAttachments).toEqual([]);
    expect(result.message.data.inputOmissions).toEqual([
      { name: "budget.xls", reason: "legacy_office_format" },
      { name: "clip.mov", reason: "unsupported_type" },
    ]);
    expect(result.created).toBe(false);
    expect(harness.queuedRunIds).toEqual([result.run.data.id, result.run.data.id]);
    expect(result.run.data.inputArtifacts).toHaveLength(1);
    expect([...harness.bucket.objects.keys()]).toEqual(
      (result.run.data.inputArtifacts ?? []).map(inputObjectKey),
    );
    expect(harness.providerApi.requests).toEqual([SLACK_FILE_URL]);
  });
});

describe("channel attachment candidates", () => {
  test("name each attachment by its own source message and position, and skip RCS media", () => {
    const slack = {
      channel: "slack",
      externalWorkspaceId: "T0001",
      provider: "slack_edge",
    } as const;
    const reportUrl = "https://files.slack.com/files-pri/T0001-F0002/download/report.pdf";
    const photo: ChannelAttachment = {
      byteSize: PNG.byteLength,
      contentType: "image/png",
      fileName: "whiteboard.png",
      kind: "image",
      url: SLACK_FILE_URL,
    };
    const report: ChannelAttachment = {
      contentType: "application/pdf",
      fileName: "report.pdf",
      kind: "document",
      url: reportUrl,
    };
    const burst = [
      sourceMessage(slack, "1700000001.000100", [report, photo]),
      sourceMessage(slack, "1700000002.000100", [photo]),
    ].map(decodeChannelIngressQueueMessage);
    const slackPhoto = {
      declared: {
        byteSize: PNG.byteLength,
        contentType: "image/png",
        fileName: "whiteboard.png",
        kind: "image",
      },
      reference: { type: "slack-file", url: SLACK_FILE_URL },
    } as const;

    expect(channelAttachmentCandidates(burst)).toEqual([
      {
        declared: { contentType: "application/pdf", fileName: "report.pdf", kind: "document" },
        identity: {
          externalMessageId: "1700000001.000100",
          ordinal: 0,
          type: "channel-attachment",
        },
        reference: { type: "slack-file", url: reportUrl },
      },
      {
        ...slackPhoto,
        identity: {
          externalMessageId: "1700000001.000100",
          ordinal: 1,
          type: "channel-attachment",
        },
      },
      {
        ...slackPhoto,
        identity: {
          externalMessageId: "1700000002.000100",
          ordinal: 0,
          type: "channel-attachment",
        },
      },
    ]);
    const rcsPhoto = sourceMessage(
      { channel: "rcs", provider: "aws_end_user_messaging_rcs" },
      "rcs-1",
      [{ contentType: "image/png", kind: "image", url: "s3://vertical-media/inbound/photo.png" }],
    );
    expect(channelAttachmentCandidates([decodeChannelIngressQueueMessage(rcsPhoto)])).toEqual([]);
  });
});
