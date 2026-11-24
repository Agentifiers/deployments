import { spyOn } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import {
  agentManifestContentHash,
  AgentManifestV1,
  type DocumentMediaType,
} from "@deployments-ai/agent-manifest";
import {
  channelIngressFlushQueueMessage,
  handleChannelIngressWith,
  type HttpApiEventLike,
} from "@deployments-ai/channel-provider-runtime/ingress";
import {
  channelIngressQueueDependencies,
  handleChannelIngressQueue,
} from "@deployments-ai/channel-provider-runtime/ingress-consumer";
import { endUserKeyDeriver } from "@deployments-ai/conversations";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  ChannelBindingRecord,
  makeChannelIngressBurstPersistence,
  makeDynamoDatabase,
  OrganizationRecord,
  Ulid,
  withCanonicalRecordKeys,
  type ChannelIngressBurstPersistence,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import type {
  DocumentFacts,
  ExtractionOutcome,
  ExtractionRequest,
} from "@deployments-ai/file-text";
import { makeS3IngressAttachmentObjectStore } from "@deployments-ai/ingress-media";
import type { ExecutePinnedHttpRequestOptions } from "@deployments-ai/net-security";
import { Schema } from "effect";
import { createHash, createHmac } from "node:crypto";
import { id } from "./agent-run.fixture.ts";
import {
  ARTIFACT_BUCKET,
  inputFilesHarness,
  type GatewayReply,
} from "./agent-run-input-files.fixture.ts";
import { processAgentRun } from "./index.ts";
import { loadTriggerMessage } from "./record-readers.ts";
import { loadRun } from "./records.ts";
import type { AgentRunQueueMessage } from "./types.ts";

const organizationId = id(1);
const projectId = id(2);
const environmentId = id(3);
const definitionId = id(5);
const releaseId = id(6);
const deploymentId = id(7);
const bindingId = id(20);
const QUIET_PERIOD_MS = 1_500;
const SLACK_SIGNING_SECRET = "slack-signing-secret";
export const TELEGRAM_TOKEN = "123456:telegram-secret";
const TELEGRAM_WEBHOOK_SECRET = "telegram-webhook-secret";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const WORKBOOK_TEXT = '## Sheet "Revenue"\nrow,A,B\n1,Region,Q2\n2,North,1300\n';
const INVOICE_TEXT = "Invoice 2026-114\nTotal due: 4,200 EUR\n";
const REGIONS_TEXT = "region,q3\nNorth,1300\n";

const EXTRACTIONS: Readonly<Record<string, ExtractionOutcome>> = {
  "broken.pdf": { reason: "unreadable", status: "unusable" },
  "invoice.pdf": extracted("application/pdf", INVOICE_TEXT, {
    kind: "pdf",
    pages: 1,
    pagesWithText: 1,
    ocrPages: 0,
  }),
  "q3.csv": extracted("text/csv", REGIONS_TEXT, { encoding: "utf-8", kind: "text", lines: 2 }),
  "q3.xlsx": extracted(XLSX, WORKBOOK_TEXT, {
    hiddenSheets: 0,
    kind: "workbook",
    sheets: [{ name: "Revenue", rows: 2 }],
  }),
};

function extracted(
  mediaType: DocumentMediaType,
  text: string,
  facts: DocumentFacts,
): ExtractionOutcome {
  const bytes = new TextEncoder().encode(text);
  return {
    facts,
    mediaType,
    status: "text",
    text: bytes,
    textSha256: createHash("sha256").update(bytes).digest("hex"),
    truncated: false,
  };
}

export const slackFileUrl = (fileId: string, name: string) =>
  `https://files.slack.com/files-pri/T0001-${fileId}/download/${name}`;

const PROVIDER_FILES: Readonly<Record<string, () => Response>> = {
  [slackFileUrl("F0001", "q3.xlsx")]: () => new Response("PK\u0003\u0004 q3 workbook"),
  [slackFileUrl("F0002", "broken.pdf")]: () => new Response("%PDF-1.7 truncated"),
  [slackFileUrl("F0004", "q3.csv")]: () => new Response(REGIONS_TEXT),
  [`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=BQACAgQinvoice`]: () =>
    Response.json({ ok: true, result: { file_path: "documents/file_3.pdf" } }),
  [`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/documents/file_3.pdf`]: () =>
    new Response("%PDF-1.7 invoice"),
};

interface SlackFile {
  readonly id: string;
  readonly mimetype: string;
  readonly name: string;
  readonly size?: number;
}

export function slackMessage(ts: string, text: string, files: readonly SlackFile[] = []) {
  return {
    channel: "D0001",
    channel_type: "im",
    ...(files.length > 0
      ? {
          files: files.map((file) => ({
            size: 2_048,
            ...file,
            url_private_download: slackFileUrl(file.id, file.name),
          })),
          subtype: "file_share",
        }
      : {}),
    text,
    ts,
    type: "message",
    user: "U0001",
  };
}

export const WORKBOOK_SHARE: SlackFile = { id: "F0001", mimetype: XLSX, name: "q3.xlsx" };
export const BROKEN_SHARE: SlackFile = {
  id: "F0002",
  mimetype: "application/pdf",
  name: "broken.pdf",
};
export const LEGACY_SHARE: SlackFile = {
  id: "F0003",
  mimetype: "application/vnd.ms-excel",
  name: "budget.xls",
};
export const CSV_SHARE: SlackFile = { id: "F0004", mimetype: "text/csv", name: "q3.csv" };
export const OVERSIZED_SHARE: SlackFile = {
  id: "F0005",
  mimetype: "application/pdf",
  name: "board-pack.pdf",
  size: 12 * 1024 * 1024,
};

function slackWebhook(event: object): HttpApiEventLike {
  const body = JSON.stringify({
    api_app_id: "A0001",
    event,
    event_id: "Ev0001",
    team_id: "T0001",
    type: "event_callback",
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const digest = createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return {
    body,
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${digest}` },
    pathParameters: { provider: "slack_edge" },
  };
}

const SLACK_CREDENTIALS = { botToken: "xoxb-slack-bot", signingSecret: SLACK_SIGNING_SECRET };

const ROUTES = {
  slack: {
    binding: {
      channel: "slack",
      externalChannelId: "D0001",
      externalWorkspaceId: "T0001",
      provider: "slack_edge",
    },
    credentials: SLACK_CREDENTIALS,
    webhook: slackWebhook,
  },
  slackChannel: {
    binding: {
      channel: "slack",
      externalChannelId: "C0001",
      externalWorkspaceId: "T0001",
      provider: "slack_edge",
    },
    credentials: SLACK_CREDENTIALS,
    webhook: slackWebhook,
  },
  telegram: {
    binding: {
      channel: "telegram",
      externalChannelId: "bot-1",
      externalWorkspaceId: "bot-1",
      provider: "telegram",
    },
    credentials: { botToken: TELEGRAM_TOKEN, webhookSecret: TELEGRAM_WEBHOOK_SECRET },
    webhook: (update: object): HttpApiEventLike => ({
      body: JSON.stringify(update),
      headers: { "x-telegram-bot-api-secret-token": TELEGRAM_WEBHOOK_SECRET },
      pathParameters: { provider: "telegram" },
    }),
  },
} as const;

function controlRecords(route: (typeof ROUTES)[keyof typeof ROUTES]) {
  const createdAt = new Date().toISOString();
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "support.files", name: "Files Helper", version: "1.0.0" },
    spec: {
      instructions: "Answer from the files people share.",
      memory: { mode: "off" },
      model: { fallbackIds: [], id: "openrouter/qwen/qwen3.7-plus" },
      runtime: { ingressAttachments: "attach" },
      sandbox: { mode: "none" },
      skills: [],
    },
  });
  const binding = Schema.decodeUnknownSync(ChannelBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        ...route.binding,
        agentDefinitionId: definitionId,
        agentDeploymentId: deploymentId,
        createdAt,
        credentialRef: { credentialId: id(21), generation: 0, store: "dynamodb-kms" },
        environmentId,
        id: bindingId,
        organizationId,
        projectId,
        status: "active",
        updatedAt: createdAt,
        version: 0,
      },
      itemType: "channel-binding" as const,
    }),
  );
  const others = [
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
          createdByPrincipalId: id(11),
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
  return { binding, others };
}

const inputField = (input: object, name: string): unknown =>
  name in input ? Reflect.get(input, name) : undefined;

export function channelWorld(provider: keyof typeof ROUTES) {
  const route = ROUTES[provider];
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  const { binding, others } = controlRecords(route);
  for (const record of [binding, ...others]) dynamo.put("control", record);

  const objects = new Map<string, { bytes: Uint8Array; contentType: string; versionId: string }>();
  const s3 = new S3Client({
    credentials: { accessKeyId: "capture-session", secretAccessKey: "capture-secret" },
    region: "us-east-1",
  });
  s3.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName === "GetObjectCommand") return next(args);
      if (context.commandName !== "PutObjectCommand") {
        throw new Error(`Unexpected ${String(context.commandName)} against the artifact bucket.`);
      }
      const input: object = args.input;
      const body = inputField(input, "Body");
      if (!(body instanceof Uint8Array)) throw new Error("Expected a byte body.");
      const versionId = `version-${String(objects.size + 1)}`;
      objects.set(String(inputField(input, "Key")), {
        bytes: body,
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

  const downloads: string[] = [];
  const extractions: ExtractionRequest["hint"][] = [];
  const flushes: string[] = [];
  const queuedRuns: AgentRunQueueMessage[] = [];
  let lastMs = 0;
  const now = () => new Date((lastMs = Math.max(lastMs + 1, Date.now())));
  let generated = 0;
  let deliveries = 0;
  let crashBeforeSettling = false;

  const ports = channelIngressQueueDependencies({
    attachments: {
      artifactBucket: ARTIFACT_BUCKET,
      extractor: {
        extract: async (request) => {
          extractions.push(request.hint);
          const outcome = EXTRACTIONS[request.hint.fileName ?? ""];
          if (!outcome) throw new Error(`No extraction for ${String(request.hint.fileName)}.`);
          return outcome;
        },
      },
      openObjectStore: async () =>
        makeS3IngressAttachmentObjectStore({
          kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/artifacts",
          s3,
        }),
      readCredentialValues: async () => route.credentials,
      transport: {
        dnsLookup: () => [{ address: "93.184.216.34", family: 4 as const }],
        pinnedRequest: async (request: ExecutePinnedHttpRequestOptions) => {
          const url = String(request.url);
          downloads.push(url);
          return PROVIDER_FILES[url]?.() ?? new Response(null, { status: 404 });
        },
      },
    },
    database,
    endUserSubjects: endUserKeyDeriver("channel-ingress-test-subject-key-0123456789"),
    enqueueFlush: async (flush) => {
      flushes.push(JSON.stringify(channelIngressFlushQueueMessage(flush)));
    },
    enqueueRun: async ({ message }) => {
      queuedRuns.push(message);
    },
    generateId: async () =>
      Schema.decodeUnknownSync(Ulid)(
        `01ARZ3NDEKTSV4RRFFQ69GA${String((generated += 1)).padStart(3, "0")}`,
      ),
  });
  const journal = makeChannelIngressBurstPersistence({
    database,
    now,
    quietPeriodMs: QUIET_PERIOD_MS,
  });
  const burstPersistence: ChannelIngressBurstPersistence = {
    ...journal,
    complete: async (flush) => {
      if (crashBeforeSettling) {
        crashBeforeSettling = false;
        throw new Error("The flush Lambda timed out before settling the burst.");
      }
      return journal.complete(flush);
    },
  };
  const runtime = { ...ports, burstPersistence };

  async function consume(body: string) {
    deliveries += 1;
    const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { batchItemFailures } = await handleChannelIngressQueue(
        { Records: [{ body, messageId: `delivery-${String(deliveries)}` }] },
        runtime,
      );
      return {
        batchItemFailures,
        errors: [...errors.mock.calls],
        warnings: [...warnings.mock.calls],
      };
    } finally {
      warnings.mockRestore();
      errors.mockRestore();
    }
  }

  async function accept(payload: object) {
    const sources: string[] = [];
    const accepted = await handleChannelIngressWith(route.webhook(payload), {
      enqueue: async (message) => void sources.push(JSON.stringify(message)),
      loadBinding: async () => binding,
      readCredentialValues: async () => route.credentials,
      teamsTokenVerifier: {
        verify: async () => {
          throw new Error("Only Teams ingress verifies a Bot Framework token.");
        },
      },
    });
    const queued = [];
    for (const source of sources) queued.push(await consume(source));
    return {
      accepted: { body: JSON.parse(accepted.body), statusCode: accepted.statusCode },
      queued,
    };
  }

  return {
    downloads,
    extractions,
    queuedRuns,
    crashNextFlushBeforeSettling() {
      crashBeforeSettling = true;
    },
    async receive(payload: object) {
      const { accepted, queued } = await accept(payload);
      lastMs += QUIET_PERIOD_MS;
      return { accepted, flushed: await consume(flushes.at(-1)!), queued };
    },
    async receiveBurst(payloads: readonly object[]) {
      const firstFlush = flushes.length;
      for (const payload of payloads) await accept(payload);
      lastMs += QUIET_PERIOD_MS;
      const flushed = [];
      for (let index = firstFlush; index < flushes.length; index += 1) {
        flushed.push(await consume(flushes[index]!));
      }
      return flushed;
    },
    async turns() {
      return Promise.all(
        queuedRuns.map(async (message) => ({
          prompt: await loadTriggerMessage(database, message),
          run: await loadRun(database, message),
        })),
      );
    },
    redeliverFlush: () => consume(flushes.at(-1)!),
    async lastRun() {
      return loadRun(database, queuedRuns.at(-1)!);
    },
    worker(replies: readonly GatewayReply[]) {
      const harness = inputFilesHarness(database, [...objects], (_request, index) => {
        const reply = replies[index];
        if (!reply) throw new Error(`The model has no reply scripted for call ${String(index)}.`);
        return reply;
      });
      const dependencies = { ...harness.dependencies, now };
      return {
        captured: harness.captured,
        run: () => processAgentRun(queuedRuns.at(-1)!, dependencies),
      };
    },
  };
}
