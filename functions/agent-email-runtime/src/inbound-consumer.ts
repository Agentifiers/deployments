import {
  AGENT_EMAIL_ATTACHMENT_DISPOSITIONS,
  type AgentEmailAttachmentDisposition,
} from "@deployments-ai/agent-email";
import {
  ingressAttachmentsEnabled,
  isRunRefusal,
  type SubmitConversationTurnInput,
  type SubmitConversationTurnResult,
} from "@deployments-ai/conversations";
import {
  InboxMailErasedError,
  Ulid,
  type InboundThreadRouteInput,
  type IngressSource,
  type MessageSource,
  type PlatformRecord,
  type Ulid as UlidValue,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { emailAttachmentCandidates, type EmailIngressAttachments } from "./inbound-attachments.ts";

const MAX_ADDRESS_BYTES = 320;
const MAX_ADDRESS_COUNT = 100;
const MAX_ATTACHMENT_COUNT = 50;
const MAX_BODY_SUMMARY_BYTES = 1024 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PROVIDER_ID_BYTES = 512;
const MAX_THREAD_KEY_BYTES = 512;
const MAX_WORKFLOW_QUEUE_MESSAGE_BYTES = 240 * 1024;

type InboxBindingRecord = Extract<PlatformRecord, { readonly itemType: "inbox-binding" }>;
type AgentDeploymentRecord = Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
type AgentReleaseRecord = Extract<PlatformRecord, { readonly itemType: "agent-release" }>;

interface AgentEmailInboundWorkflowAttachmentV1 {
  readonly byteSize: number;
  readonly contentType: string;
  readonly disposition: AgentEmailAttachmentDisposition;
  readonly fileName: string;
  readonly id: UlidValue;
}

export interface AgentEmailInboundWorkflowMessageV1 {
  readonly attachments: readonly AgentEmailInboundWorkflowAttachmentV1[];
  readonly bodySummary: string;
  readonly ccAddresses: readonly string[];
  readonly environmentId: UlidValue;
  readonly fromAddress: string;
  readonly inboxId: UlidValue;
  readonly internetMessageId?: string;
  readonly messageId: UlidValue;
  readonly organizationId: UlidValue;
  readonly projectId: UlidValue;
  readonly provider: "ses";
  readonly providerMessageId: string;
  readonly receivedAt: string;
  readonly receiptRegion: string;
  readonly subject: string;
  readonly threadKey: string;
  readonly toAddresses: readonly string[];
  readonly type: "agent-email.inbound-workflow";
  readonly version: 1;
}

export type StoredInboundMessageSource =
  | { readonly kind: "erased" }
  | { readonly kind: "found"; readonly source: MessageSource };

export interface AgentEmailInboundWorkflowDependencies {
  readonly loadBindings: (
    message: AgentEmailInboundWorkflowMessageV1,
  ) => Promise<readonly InboxBindingRecord[]>;
  readonly loadDeployment: (
    message: AgentEmailInboundWorkflowMessageV1,
    deploymentId: UlidValue,
  ) => Promise<AgentDeploymentRecord | undefined>;
  readonly loadRelease: (
    message: AgentEmailInboundWorkflowMessageV1,
    releaseId: UlidValue,
  ) => Promise<AgentReleaseRecord | undefined>;
  readonly loadMessageSource: (
    message: AgentEmailInboundWorkflowMessageV1,
  ) => Promise<StoredInboundMessageSource>;
  readonly openIngressAttachments: () => EmailIngressAttachments;
  readonly reserveThreadRoute: (input: InboundThreadRouteInput) => Promise<UlidValue>;
  readonly submitTurn: (
    input: SubmitConversationTurnInput,
  ) => Promise<SubmitConversationTurnResult>;
}

export interface AgentEmailInboundWorkflowSubmission {
  readonly bindingId: UlidValue;
  readonly result: SubmitConversationTurnResult;
}

export interface AgentEmailInboundWorkflowResult {
  readonly ignoredBindingIds: readonly UlidValue[];
  readonly submissions: readonly AgentEmailInboundWorkflowSubmission[];
}

export interface AgentEmailWorkflowBindingFailure {
  readonly bindingId: UlidValue;
  readonly cause: unknown;
}

export class AgentEmailWorkflowDispatchError extends AggregateError {
  readonly failures: readonly AgentEmailWorkflowBindingFailure[];
  readonly submissions: readonly AgentEmailInboundWorkflowSubmission[];

  constructor(
    failures: readonly AgentEmailWorkflowBindingFailure[],
    submissions: readonly AgentEmailInboundWorkflowSubmission[],
  ) {
    super(
      failures.map((failure) => failure.cause),
      `Agent email workflow dispatch failed for ${failures.length} binding(s).`,
    );
    this.name = "AgentEmailWorkflowDispatchError";
    this.failures = failures;
    this.submissions = submissions;
  }
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(
  value: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
  maximumBytes: number,
) {
  const candidate = value[field];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error(`${label}.${field} is required.`);
  }
  const normalized = candidate.trim();
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new Error(`${label}.${field} exceeds ${maximumBytes} UTF-8 bytes.`);
  }
  return normalized;
}

function optionalText(
  value: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
  maximumBytes: number,
) {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error(`${label}.${field} must be a non-empty string when provided.`);
  }
  const normalized = candidate.trim();
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new Error(`${label}.${field} exceeds ${maximumBytes} UTF-8 bytes.`);
  }
  return normalized;
}

function ulid(value: unknown, label: string): UlidValue {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    throw new Error(`${label} must be a canonical ULID.`);
  }
}

function addresses(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ADDRESS_COUNT) {
    throw new Error(
      `Agent email inbound workflow ${field} must contain at most ${MAX_ADDRESS_COUNT} addresses.`,
    );
  }
  return value.map((candidate, index) => {
    if (
      typeof candidate !== "string" ||
      !candidate.trim() ||
      Buffer.byteLength(candidate.trim(), "utf8") > MAX_ADDRESS_BYTES
    ) {
      throw new Error(
        `Agent email inbound workflow ${field}[${index}] must be a non-empty address of at most ${MAX_ADDRESS_BYTES} UTF-8 bytes.`,
      );
    }
    return candidate.trim();
  });
}

function attachments(value: unknown): readonly AgentEmailInboundWorkflowAttachmentV1[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(
      `Agent email inbound workflow attachments must contain at most ${MAX_ATTACHMENT_COUNT} entries.`,
    );
  }
  return value.map((candidate, index) => {
    const attachment = record(candidate, `Agent email inbound workflow attachments[${index}]`);
    if (!Number.isSafeInteger(attachment.byteSize) || Number(attachment.byteSize) < 0) {
      throw new Error(
        `Agent email inbound workflow attachments[${index}].byteSize must be a non-negative safe integer.`,
      );
    }
    const disposition = AGENT_EMAIL_ATTACHMENT_DISPOSITIONS.find(
      (candidate) => candidate === attachment.disposition,
    );
    if (!disposition) {
      throw new Error(
        `Agent email inbound workflow attachments[${index}].disposition must be attachment or inline.`,
      );
    }
    return {
      byteSize: Number(attachment.byteSize),
      contentType: text(
        attachment,
        "contentType",
        `Agent email inbound workflow attachments[${index}]`,
        998,
      ),
      disposition,
      fileName: text(
        attachment,
        "fileName",
        `Agent email inbound workflow attachments[${index}]`,
        1024,
      ),
      id: ulid(attachment.id, `Agent email inbound workflow attachments[${index}].id`),
    };
  });
}

export function decodeAgentEmailInboundWorkflowMessage(
  value: unknown,
): AgentEmailInboundWorkflowMessageV1 {
  const message = record(value, "Agent email inbound workflow message");
  if (message.type !== "agent-email.inbound-workflow" || message.version !== 1) {
    throw new Error("Agent email inbound workflow message version is unsupported.");
  }
  if (message.provider !== "ses") {
    throw new Error("Agent email inbound workflow provider is unsupported.");
  }
  if (typeof message.bodySummary !== "string") {
    throw new Error("Agent email inbound workflow message.bodySummary must be a string.");
  }
  if (Buffer.byteLength(message.bodySummary, "utf8") > MAX_BODY_SUMMARY_BYTES) {
    throw new Error(
      `Agent email inbound workflow message.bodySummary exceeds ${MAX_BODY_SUMMARY_BYTES} UTF-8 bytes.`,
    );
  }
  const receivedAt = text(message, "receivedAt", "Agent email inbound workflow message", 64);
  if (!Number.isFinite(Date.parse(receivedAt))) {
    throw new Error("Agent email inbound workflow receivedAt must be an ISO timestamp.");
  }
  const subject =
    typeof message.subject === "string"
      ? message.subject
      : (() => {
          throw new Error("Agent email inbound workflow message.subject must be a string.");
        })();
  if (Buffer.byteLength(subject, "utf8") > 4 * 1024) {
    throw new Error("Agent email inbound workflow message.subject exceeds 4096 UTF-8 bytes.");
  }
  const internetMessageId = optionalText(
    message,
    "internetMessageId",
    "Agent email inbound workflow message",
    MAX_THREAD_KEY_BYTES,
  );
  return {
    attachments: attachments(message.attachments),
    bodySummary: message.bodySummary,
    ccAddresses: addresses(message.ccAddresses, "ccAddresses"),
    environmentId: ulid(message.environmentId, "Agent email inbound workflow environmentId"),
    fromAddress: text(
      message,
      "fromAddress",
      "Agent email inbound workflow message",
      MAX_ADDRESS_BYTES,
    ),
    inboxId: ulid(message.inboxId, "Agent email inbound workflow inboxId"),
    ...(internetMessageId ? { internetMessageId } : {}),
    messageId: ulid(message.messageId, "Agent email inbound workflow messageId"),
    organizationId: ulid(message.organizationId, "Agent email inbound workflow organizationId"),
    projectId: ulid(message.projectId, "Agent email inbound workflow projectId"),
    provider: "ses",
    providerMessageId: text(
      message,
      "providerMessageId",
      "Agent email inbound workflow message",
      MAX_PROVIDER_ID_BYTES,
    ),
    receivedAt,
    receiptRegion: text(message, "receiptRegion", "Agent email inbound workflow message", 64),
    subject,
    threadKey: text(
      message,
      "threadKey",
      "Agent email inbound workflow message",
      MAX_THREAD_KEY_BYTES,
    ),
    toAddresses: addresses(message.toAddresses, "toAddresses"),
    type: "agent-email.inbound-workflow",
    version: 1,
  };
}

export function serializeAgentEmailInboundWorkflowMessage(
  message: AgentEmailInboundWorkflowMessageV1,
  maximumBytes = MAX_WORKFLOW_QUEUE_MESSAGE_BYTES,
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Agent email workflow queue message limit is invalid.");
  }
  const complete = JSON.stringify(message);
  if (Buffer.byteLength(complete, "utf8") <= maximumBytes) return complete;
  const characters = Array.from(message.bodySummary);
  let lower = 0;
  let upper = characters.length;
  let serialized = JSON.stringify({ ...message, bodySummary: "" });
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new Error("Agent email workflow metadata exceeds the queue message-size limit.");
  }
  while (lower <= upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    const candidate = JSON.stringify({
      ...message,
      bodySummary: characters.slice(0, midpoint).join(""),
    });
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) {
      serialized = candidate;
      lower = midpoint + 1;
    } else {
      upper = midpoint - 1;
    }
  }
  return serialized;
}

function singleLine(value: string, fallback: string) {
  const normalized = Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return normalized || fallback;
}

function utf8Prefix(value: string, maximumBytes: number) {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function characterPrefix(value: string, maximumCharacters: number) {
  return Array.from(value).slice(0, maximumCharacters).join("");
}

export function renderAgentEmailWorkflowContent(message: AgentEmailInboundWorkflowMessageV1) {
  const attachmentSummary =
    message.attachments.length === 0
      ? []
      : [
          `Attachments (${message.attachments.length}):`,
          ...message.attachments.map(
            (attachment) =>
              `- ${singleLine(attachment.fileName, "attachment")} (${singleLine(
                attachment.contentType,
                "application/octet-stream",
              )}, ${attachment.byteSize} bytes)`,
          ),
        ];
  const header = [
    "Inbound email",
    `From: ${singleLine(message.fromAddress, "unknown sender")}`,
    `To: ${message.toAddresses.map((address) => singleLine(address, "unknown")).join(", ")}`,
    ...(message.ccAddresses.length > 0
      ? [`Cc: ${message.ccAddresses.map((address) => singleLine(address, "unknown")).join(", ")}`]
      : []),
    `Subject: ${singleLine(message.subject, "(no subject)")}`,
    ...attachmentSummary,
  ].join("\n");
  const combined = `${header}\n\n${message.bodySummary.trim()}`.trim();
  return utf8Prefix(combined, MAX_CONTENT_BYTES).trim();
}

export function agentEmailWorkflowIdempotencyKey(
  message: AgentEmailInboundWorkflowMessageV1,
  bindingId: UlidValue,
) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "v1",
        message.receiptRegion,
        message.providerMessageId,
        message.inboxId,
        message.messageId,
        bindingId,
      ]),
    )
    .digest("hex");
  return `agent-email-inbound:v1:${digest}`;
}

function messageMetadata(message: AgentEmailInboundWorkflowMessageV1) {
  const metadata = {
    agentEmailInboxId: message.inboxId,
    agentEmailMessageId: message.messageId,
    attachmentCount: message.attachments.length,
    fromAddress: message.fromAddress,
    internetMessageId: message.internetMessageId,
    provider: message.provider,
    providerMessageId: message.providerMessageId,
    receiptRegion: message.receiptRegion,
    receivedAt: message.receivedAt,
    source: "agent-email",
    threadKey: message.threadKey,
  };
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) {
    throw new Error("Agent email workflow metadata exceeds 64 KiB.");
  }
  return JSON.parse(JSON.stringify(metadata)) as Readonly<Record<string, unknown>>;
}

function validateBindingScope(
  binding: InboxBindingRecord,
  message: AgentEmailInboundWorkflowMessageV1,
) {
  if (
    binding.data.organizationId !== message.organizationId ||
    binding.data.projectId !== message.projectId ||
    binding.data.environmentId !== message.environmentId ||
    binding.data.inboxId !== message.inboxId
  ) {
    throw new Error("Agent email binding does not match the persisted message scope.");
  }
}

function requireRunnableDeployment(
  binding: InboxBindingRecord,
  deployment: AgentDeploymentRecord | undefined,
  message: AgentEmailInboundWorkflowMessageV1,
): AgentDeploymentRecord | undefined {
  if (!binding.data.agentDeploymentId || !binding.data.agentDefinitionId) {
    return undefined;
  }
  if (
    !deployment ||
    deployment.data.id !== binding.data.agentDeploymentId ||
    deployment.data.agentDefinitionId !== binding.data.agentDefinitionId ||
    binding.data.externalId !== binding.data.agentDefinitionId ||
    deployment.data.organizationId !== message.organizationId ||
    deployment.data.projectId !== message.projectId ||
    deployment.data.environmentId !== message.environmentId ||
    deployment.data.currentState !== "ready" ||
    deployment.data.desiredState !== "running"
  ) {
    return undefined;
  }
  return deployment;
}

async function submitBinding(
  binding: InboxBindingRecord,
  message: AgentEmailInboundWorkflowMessageV1,
  dependencies: AgentEmailInboundWorkflowDependencies,
  ingressAttachments: EmailIngressAttachments,
  source: MessageSource,
): Promise<AgentEmailInboundWorkflowSubmission | undefined> {
  if (!binding.data.agentDeploymentId) return undefined;
  const deployment = requireRunnableDeployment(
    binding,
    await dependencies.loadDeployment(message, binding.data.agentDeploymentId),
    message,
  );
  if (!deployment) return undefined;
  const threadId = await dependencies.reserveThreadRoute({
    agentDeploymentId: deployment.data.id,
    channel: "email",
    createdAt: message.receivedAt,
    environmentId: message.environmentId,
    externalChannelId: message.inboxId,
    externalThreadKey: message.threadKey,
    organizationId: message.organizationId,
    projectId: message.projectId,
    provider: "ses",
    sourceId: binding.data.id,
    sourceKind: "agent-email-binding",
  });
  const owner: IngressSource = {
    sourceId: binding.data.id,
    sourceKind: "agent-email-binding",
    type: "ingress",
  };
  const candidates = emailAttachmentCandidates(message);
  const capture =
    candidates.length > 0 &&
    (await ingressAttachmentsEnabled(deployment, (releaseId) =>
      dependencies.loadRelease(message, releaseId),
    ));
  const attachments = await ingressAttachments.prepare({
    candidates,
    capture,
    owner,
    scope: message,
    threadId,
  });
  let result: SubmitConversationTurnResult;
  try {
    result = await dependencies.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deployment.data.id,
      channel: "email",
      content: renderAgentEmailWorkflowContent(message),
      createThreadIfMissing: true,
      environmentId: message.environmentId,
      executor: "hosted",
      externalThreadKey: message.threadKey,
      idempotencyKey: agentEmailWorkflowIdempotencyKey(message, binding.data.id),
      initiatingCaller: owner,
      ...(attachments.offeredArtifactIds.length > 0
        ? { inputArtifacts: attachments.offeredArtifactIds }
        : {}),
      messageMetadata: messageMetadata(message),
      messageSource: source,
      organizationId: message.organizationId,
      projectId: message.projectId,
      ...(attachments.skipped.length > 0 ? { skippedInputFiles: attachments.skipped } : {}),
      threadId,
      title: characterPrefix(`Email: ${singleLine(message.subject, "(no subject)")}`, 120),
      trigger: "email",
    });
  } catch (cause) {
    // Like an unrunnable deployment, a run refusal ignores this binding: redelivery cannot admit
    // the run until the budget or the organization's standing changes.
    if (isRunRefusal(cause)) return undefined;
    if (cause instanceof InboxMailErasedError) return undefined;
    throw cause;
  }
  const notAttached = result.created ? result.omittedInputArtifacts : [];
  if (
    capture &&
    (attachments.omitted.length > 0 || attachments.skipped.length > 0 || notAttached.length > 0)
  ) {
    console.warn("Agent email attachments were left out of the run.", {
      bindingId: binding.data.id,
      messageId: message.messageId,
      notAttached,
      notCaptured: attachments.omitted,
      skipped: attachments.skipped,
    });
  }
  return { bindingId: binding.data.id, result };
}

export async function processAgentEmailInboundWorkflow(
  value: unknown,
  dependencies: AgentEmailInboundWorkflowDependencies,
): Promise<AgentEmailInboundWorkflowResult> {
  const message = decodeAgentEmailInboundWorkflowMessage(value);
  const stored = await dependencies.loadMessageSource(message);
  if (stored.kind === "erased") return { ignoredBindingIds: [], submissions: [] };
  const { source } = stored;
  const bindings = await dependencies.loadBindings(message);
  for (const binding of bindings) validateBindingScope(binding, message);

  const active = bindings.filter(
    (binding) => binding.data.bindingType === "platform_agent" && binding.data.status === "active",
  );
  const ignoredBindingIds = bindings
    .filter(
      (binding) =>
        binding.data.bindingType !== "platform_agent" || binding.data.status !== "active",
    )
    .map((binding) => binding.data.id);
  const ingressAttachments = dependencies.openIngressAttachments();
  const settled = await Promise.allSettled(
    active.map((binding) =>
      submitBinding(binding, message, dependencies, ingressAttachments, source),
    ),
  );
  const submissions: AgentEmailInboundWorkflowSubmission[] = [];
  const failures: AgentEmailWorkflowBindingFailure[] = [];
  for (const [index, result] of settled.entries()) {
    const binding = active[index]!;
    if (result.status === "fulfilled") {
      if (result.value) submissions.push(result.value);
      else ignoredBindingIds.push(binding.data.id);
    } else failures.push({ bindingId: binding.data.id, cause: result.reason });
  }
  if (failures.length > 0) throw new AgentEmailWorkflowDispatchError(failures, submissions);
  return { ignoredBindingIds, submissions };
}
