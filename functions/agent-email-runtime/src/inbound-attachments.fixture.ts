import { GetObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import type { AgentEmailAttachmentDisposition } from "@deployments-ai/agent-email";
import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import {
  createConversationService,
  type ConversationQueueMessage,
} from "@deployments-ai/conversations";
import { makeTenantRoleSessions, type TenantRoleSts } from "@deployments-ai/credential-vault";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  InboxAttachmentRecord,
  InboxBindingRecord,
  inboxMessageRecord,
  makeDynamoDatabase,
  makeInboundPersistence,
  makeIngressInputArtifactPersistence,
  tableForItemType,
  Ulid,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import {
  ExtractionUnavailableError,
  type ExtractionOutcome,
  type ExtractionRequest,
  type FileTextExtractor,
} from "@deployments-ai/file-text";
import { makeS3IngressAttachmentObjectStore } from "@deployments-ai/ingress-media";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  makeEmailIngressAttachments,
  type EmailAttachmentObjectStore,
} from "./inbound-attachments.ts";
import {
  processAgentEmailInboundWorkflow,
  type AgentEmailInboundWorkflowMessageV1,
} from "./inbound-consumer.ts";
import { agentEmailWorkflowMessageSource } from "./inbound-receipt-routing.ts";

type EmailAttachment = AgentEmailInboundWorkflowMessageV1["attachments"][number];

const ulid = Schema.decodeUnknownSync(Ulid);
const id = (suffix: string) => ulid(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);
const timestamp = "2026-10-07T12:00:00.000Z";

export const EMAIL_BUCKET = "agent-email-test";
export const ARTIFACT_BUCKET = "platform-artifacts-test";
export const CAPTURE_ROLE_ARN = "arn:aws:iam::123456789012:role/agent-ingress-attachment-capture";
const ARTIFACT_KMS_KEY_ARN = "arn:aws:kms:us-east-2:123456789012:key/data";
export const attachmentObjectOf = (attachmentId: Ulid) => ({
  Bucket: EMAIL_BUCKET,
  Key: `tenants/t1/attachments/inbox/message/${attachmentId}/revision`,
  VersionId: "attachment-v1",
});
export const emailAttachmentId = (ordinal: number) => id(`2${ordinal}`);
const attachmentId = emailAttachmentId(0);
export const attachmentObject = attachmentObjectOf(attachmentId);

export const png = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new TextEncoder().encode("receipt photo"),
]);

export interface EmailFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly disposition: AgentEmailAttachmentDisposition;
  readonly fileName: string;
}
const receipt: EmailFile = {
  bytes: png,
  contentType: "image/png",
  disposition: "attachment",
  fileName: "receipt.png",
};

const attachmentOf = (file: EmailFile, attachmentId: Ulid): EmailAttachment => ({
  byteSize: file.bytes.byteLength,
  contentType: file.contentType,
  disposition: file.disposition,
  fileName: file.fileName,
  id: attachmentId,
});
export const message: AgentEmailInboundWorkflowMessageV1 = {
  attachments: [attachmentOf(receipt, attachmentId)],
  bodySummary: "What does this receipt say?",
  ccAddresses: [],
  environmentId: id("2"),
  fromAddress: "sender@example.com",
  inboxId: id("3"),
  messageId: id("4"),
  organizationId: id("1"),
  projectId: id("5"),
  provider: "ses",
  providerMessageId: "ses-message-1",
  receivedAt: timestamp,
  receiptRegion: "us-east-2",
  subject: "Receipt",
  threadKey: "<root@example.com>",
  toAddresses: ["agent@agents.example.com"],
  type: "agent-email.inbound-workflow",
  version: 1,
};

export const legacyWordAttachment: EmailAttachment = {
  byteSize: 24_576,
  contentType: "application/msword",
  disposition: "attachment",
  fileName: "contract.doc",
  id: id("41"),
};

export const oversizedPdfAttachment: EmailAttachment = {
  byteSize: 12 * 1024 * 1024,
  contentType: "application/pdf",
  disposition: "attachment",
  fileName: "annual-report.pdf",
  id: id("42"),
};

const scope = {
  environmentId: message.environmentId,
  organizationId: message.organizationId,
  projectId: message.projectId,
};

function attachmentRecord(file: EmailFile, attachmentId: Ulid, ordinal: number) {
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const object = attachmentObjectOf(attachmentId);
  return Schema.decodeUnknownSync(InboxAttachmentRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        contentType: file.contentType,
        createdAt: timestamp,
        disposition: file.disposition,
        fileName: file.fileName,
        id: attachmentId,
        inboxMessageId: message.messageId,
        ordinal,
        sha256,
        storage: {
          bucket: object.Bucket,
          byteSize: file.bytes.byteLength,
          contentType: file.contentType,
          fileName: file.fileName,
          key: object.Key,
          sha256,
          versionId: object.VersionId,
        },
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "inbox-attachment" as const,
    }),
  );
}

export const INBOX_THREAD_ID = id("60");

export const storedMessage = inboxMessageRecord(
  scope,
  {
    attachments: [],
    bccAddresses: [],
    ccAddresses: message.ccAddresses,
    createdAt: timestamp,
    direction: "inbound",
    fromAddress: message.fromAddress,
    id: message.messageId,
    inboxId: message.inboxId,
    organizationId: message.organizationId,
    receivedAt: timestamp,
    references: [],
    replyToAddresses: [],
    reprocessCount: 0,
    status: "received",
    subject: message.subject,
    threadId: INBOX_THREAD_ID,
    threadKey: message.threadKey,
    toAddresses: message.toAddresses,
    updatedAt: timestamp,
  },
  [],
);

export interface PlatformAgent {
  readonly binding: Extract<PlatformRecord, { readonly itemType: "inbox-binding" }>;
  readonly deployment: Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
  readonly release: Extract<PlatformRecord, { readonly itemType: "agent-release" }>;
  readonly threadId: Ulid;
}

export function platformAgent(
  suffix: "1" | "2",
  runtime: { readonly ingressAttachments?: "attach" } = { ingressAttachments: "attach" },
): PlatformAgent {
  const agentDefinitionId = id(`5${suffix}`);
  const releaseId = id(`9${suffix}`);
  const binding = Schema.decodeUnknownSync(InboxBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        agentDefinitionId,
        agentDeploymentId: id(`6${suffix}`),
        bindingType: "platform_agent" as const,
        createdAt: timestamp,
        externalId: agentDefinitionId,
        id: id(`7${suffix}`),
        inboxId: message.inboxId,
        metadata: {},
        status: "active" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "inbox-binding" as const,
    }),
  );
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: `email.agent-${suffix}`, name: `Email Agent ${suffix}`, version: "1.0.0" },
    spec: {
      instructions: "Answer the email.",
      model: { id: "openrouter/qwen/qwen3.7-plus" },
      runtime,
      sandbox: { mode: "none" },
    },
  });
  const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        agentDefinitionId,
        contentHash: agentManifestContentHash(manifest),
        createdAt: timestamp,
        createdByPrincipalId: id("8"),
        id: releaseId,
        manifest,
        releaseNumber: 1,
        status: "active" as const,
        version: 0,
      },
      itemType: "agent-release" as const,
    }),
  );
  const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        agentDefinitionId,
        agentReleaseId: releaseId,
        createdAt: timestamp,
        currentState: "ready" as const,
        desiredState: "running" as const,
        id: binding.data.agentDeploymentId,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
  return { binding, deployment, release, threadId: id(`3${suffix}`) };
}

function s3Error(name: string, httpStatusCode: number) {
  return new S3ServiceException({
    $fault: httpStatusCode >= 500 ? "server" : "client",
    $metadata: { httpStatusCode },
    message: name,
    name,
  });
}

type EmailObject = Uint8Array | { readonly missing: 403 | 404 };

function fakeEmailBucket(stored: ReadonlyMap<string, EmailObject>) {
  const reads: GetObjectCommand["input"][] = [];
  const failures = { nextGet: false };
  const objectStore: EmailAttachmentObjectStore = {
    send: async (command) => {
      reads.push(command.input);
      if (failures.nextGet) {
        failures.nextGet = false;
        throw s3Error("SlowDown", 503);
      }
      const { Bucket, Key, VersionId } = command.input;
      const object =
        Bucket === EMAIL_BUCKET && VersionId === attachmentObject.VersionId
          ? stored.get(Key ?? "")
          : undefined;
      if (object instanceof Uint8Array) {
        return { Body: { transformToByteArray: async () => object } };
      }
      throw object?.missing === 404 ? s3Error("NoSuchVersion", 404) : s3Error("AccessDenied", 403);
    },
  };
  return { failures, objectStore, reads };
}

const inputField = (input: object, name: string): unknown =>
  name in input ? Reflect.get(input, name) : undefined;

interface StoredArtifactObject {
  readonly bytes: Uint8Array;
  readonly checksumSha256: string;
  readonly contentType: string;
  readonly versionId: string;
}

function fakeArtifactBucket() {
  const objects = new Map<string, StoredArtifactObject>();
  const failures = { nextPut: false };
  const s3 = new S3Client({
    credentials: { accessKeyId: "capture-session", secretAccessKey: "capture-secret" },
    region: "us-east-2",
  });
  s3.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName === "GetObjectCommand") return next(args);
      const input: object = args.input;
      const key = String(inputField(input, "Key"));
      if (context.commandName === "HeadObjectCommand") {
        const stored = objects.get(key);
        if (!stored) throw s3Error("NotFound", 404);
        return {
          output: {
            $metadata: { httpStatusCode: 200 },
            ChecksumSHA256: stored.checksumSha256,
            ContentLength: stored.bytes.byteLength,
            ContentType: stored.contentType,
            ETag: `"etag-${stored.versionId}"`,
            SSEKMSKeyId: ARTIFACT_KMS_KEY_ARN,
            ServerSideEncryption: "aws:kms",
            VersionId: stored.versionId,
          },
          response: {},
        };
      }
      if (context.commandName !== "PutObjectCommand") {
        throw new Error(`Unexpected ${String(context.commandName)} against the artifact bucket.`);
      }
      if (failures.nextPut) {
        failures.nextPut = false;
        throw s3Error("ServiceUnavailable", 503);
      }
      const body = inputField(input, "Body");
      if (!(body instanceof Uint8Array)) throw new Error("Expected a byte body.");
      if (inputField(input, "IfNoneMatch") === "*" && objects.has(key)) {
        throw s3Error("PreconditionFailed", 412);
      }
      if (inputField(input, "SSEKMSKeyId") !== ARTIFACT_KMS_KEY_ARN) {
        throw s3Error("AccessDenied", 403);
      }
      const versionId = `version-${String(objects.size + 1)}`;
      objects.set(key, {
        bytes: body,
        checksumSha256: String(inputField(input, "ChecksumSHA256")),
        contentType: String(inputField(input, "ContentType")),
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
    failures,
    objects,
    store: makeS3IngressAttachmentObjectStore({ kmsKeyArn: ARTIFACT_KMS_KEY_ARN, s3 }),
  };
}

export const extractedText = new TextEncoder().encode("--- Page 1 ---\nNorth led Q3.");
const extractedPdf: ExtractionOutcome = {
  facts: { kind: "pdf", pages: 1, pagesWithText: 1, ocrPages: 0 },
  mediaType: "application/pdf",
  status: "text",
  text: extractedText,
  textSha256: createHash("sha256").update(extractedText).digest("hex"),
  truncated: false,
};

function recordingExtractor(outcome: ExtractionOutcome) {
  const requests: ExtractionRequest[] = [];
  const failures = { next: false };
  const extractor: FileTextExtractor = {
    extract: async (request) => {
      requests.push(request);
      if (failures.next) {
        failures.next = false;
        throw new ExtractionUnavailableError("Document extraction was throttled.");
      }
      return outcome;
    },
  };
  return { extractor, failures, requests };
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

export interface EmailWorkflowOptions {
  readonly artifactBucket?: string;
  readonly attachments?: readonly EmailAttachment[];
  readonly emailObject?: EmailObject;
  readonly extraction?: ExtractionOutcome;
  readonly files?: readonly EmailFile[];
}

export function emailWorkflow(
  agents: readonly PlatformAgent[],
  options: EmailWorkflowOptions = {},
) {
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        id: message.organizationId,
        name: "Email Organization",
        slug: "email-organization",
        status: "active" as const,
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  const files = (options.files ?? [receipt]).map((file, ordinal) => ({
    attachmentId: emailAttachmentId(ordinal),
    file,
    ordinal,
  }));
  for (const record of [
    ...files.map(({ attachmentId, file, ordinal }) =>
      attachmentRecord(file, attachmentId, ordinal),
    ),
    storedMessage,
    ...agents.flatMap((agent) => [agent.deployment, agent.release]),
  ]) {
    dynamo.put(tableForItemType(record.itemType), record);
  }
  const emailBucket = fakeEmailBucket(
    new Map(
      files.map(({ attachmentId, file, ordinal }) => [
        attachmentObjectOf(attachmentId).Key,
        ordinal === 0 && options.emailObject ? options.emailObject : file.bytes,
      ]),
    ),
  );
  const artifactBucket = fakeArtifactBucket();
  const capture = fakeCaptureSts();
  const extraction = recordingExtractor(options.extraction ?? extractedPdf);
  const openArtifactObjects = makeTenantRoleSessions({
    open: () => artifactBucket.store,
    roleArn: CAPTURE_ROLE_ARN,
    sessionName: "email-attachment-capture",
    sts: capture.sts,
  });
  const persistence = makeInboundPersistence({ database });
  let nextId = 100;
  const queuedRuns: ConversationQueueMessage[] = [];
  const conversations = createConversationService({
    database,
    enqueueRun: async ({ message: queued }) => {
      queuedRuns.push(queued);
    },
    generateId: async () => id(String(nextId++)),
  });

  const delivered = {
    ...message,
    attachments:
      options.attachments ??
      files.map(({ attachmentId, file }) => attachmentOf(file, attachmentId)),
  };
  const deliver = () =>
    processAgentEmailInboundWorkflow(delivered, {
      loadBindings: async () => agents.map((agent) => agent.binding),
      loadDeployment: (scope, deploymentId) => persistence.loadAgentDeployment(scope, deploymentId),
      loadMessageSource: (command) => agentEmailWorkflowMessageSource(database, command),
      loadRelease: (scope, releaseId) => persistence.loadAgentRelease(scope, releaseId),
      openIngressAttachments: () =>
        makeEmailIngressAttachments({
          artifactBucket: options.artifactBucket ?? ARTIFACT_BUCKET,
          database,
          emailBuckets: [EMAIL_BUCKET],
          emailObjects: emailBucket.objectStore,
          extractor: extraction.extractor,
          openArtifactObjects,
        }),
      reserveThreadRoute: async (input) => {
        const agent = agents.find((candidate) => candidate.binding.data.id === input.sourceId);
        if (!agent) throw new Error(`No thread for source ${input.sourceId}.`);
        return agent.threadId;
      },
      submitTurn: (input) => conversations.submitTurn(input),
    });

  return {
    artifact: (artifactId: string) =>
      makeIngressInputArtifactPersistence(database).find(scope, ulid(artifactId)),
    artifactBucket,
    capture,
    database,
    deliver,
    dynamo,
    emailBucket,
    extraction,
    queuedRuns,
    storedRunCount: () =>
      dynamo.items("execution").filter((item) => item.itemType === "run").length,
  };
}
