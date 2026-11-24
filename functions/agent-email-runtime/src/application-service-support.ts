import {
  agentEmailCursor,
  AgentEmailValidationError,
  buildAgentEmailDomainEvent,
  parseAgentEmailCursor,
  type AgentEmailAttachmentRecord,
  type AgentEmailBlobStore,
  AgentEmailDnsRecordSchema,
  type AgentEmailDomainProvisioner,
  type AgentEmailDomainRecord,
  type AgentEmailDraftRecord,
  type AgentEmailInboxBindingRecord,
  type AgentEmailInboxRecord,
  type AgentEmailMessageRecord,
  type AgentEmailPlacementProvisioner,
  type AgentEmailPlacementRecord,
  type AgentEmailPolicyRecord,
  type AgentEmailSuppressionRecord,
  type AgentEmailThreadRecord,
} from "@deployments-ai/agent-email";
import { PublicId } from "@deployments-ai/api-contract/primitives";
import {
  type AgentEmailEndUserKeys,
  type AgentEmailPlatformScope,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  AgentEmailApiError,
  type AgentEmailApiInvocation,
  type AgentEmailApiScope,
} from "./api-handler.ts";
import { definedFields } from "./record-fields.ts";

export type RecordOf<ItemType extends PlatformRecord["itemType"]> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

export const DEFAULT_POLICY = {
  bounceRateThresholdBasisPoints: 500,
  complaintRateThresholdBasisPoints: 10,
  dailyOutboundMessageLimit: 1_000,
  maxAttachmentBytes: 4 * 1024 * 1024,
  maxRecipientsPerMessage: 47,
  rawRetentionDays: 30,
} as const;

export const MAX_SEARCH_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_SEARCH_MESSAGES = 100;
export const MAX_PUBLIC_USAGE_RANGE_MILLISECONDS = 31 * 24 * 60 * 60 * 1_000;
export const MAX_PUBLIC_USAGE_RECORDS = 10_000;
export const THREAD_SEARCH_MESSAGE_PAGE_SIZE = 25;

export type AgentEmailCursorPosition = {
  readonly createdAt: string;
  readonly id: string;
};

export type AgentEmailThreadSearchCursor =
  | {
      readonly kind: "after-thread";
      readonly thread: AgentEmailCursorPosition;
    }
  | {
      readonly hasFollowing: boolean;
      readonly kind: "within-thread";
      readonly message?: AgentEmailCursorPosition;
      readonly thread: AgentEmailCursorPosition;
    };

function isAgentEmailCursorPosition(value: unknown): value is AgentEmailCursorPosition {
  return (
    typeof value === "object" &&
    value !== null &&
    "createdAt" in value &&
    "id" in value &&
    typeof value.createdAt === "string" &&
    typeof value.id === "string" &&
    !Number.isNaN(Date.parse(value.createdAt))
  );
}

export function agentEmailThreadSearchCursor(
  thread: AgentEmailCursorPosition,
  message: AgentEmailCursorPosition | undefined,
  hasFollowing: boolean,
) {
  return Buffer.from(
    JSON.stringify({
      hasFollowing,
      kind: "agent-email-thread-search-v1",
      ...(message ? { message } : {}),
      thread,
    }),
    "utf8",
  ).toString("base64url");
}

export function parseAgentEmailThreadSearchCursor(
  value: string | undefined,
): AgentEmailThreadSearchCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "kind" in decoded &&
      decoded.kind === "agent-email-thread-search-v1"
    ) {
      if (
        !("thread" in decoded) ||
        !isAgentEmailCursorPosition(decoded.thread) ||
        !("hasFollowing" in decoded) ||
        typeof decoded.hasFollowing !== "boolean" ||
        ("message" in decoded &&
          decoded.message !== undefined &&
          !isAgentEmailCursorPosition(decoded.message))
      ) {
        throw new Error("invalid");
      }
      return {
        hasFollowing: decoded.hasFollowing,
        kind: "within-thread",
        ...("message" in decoded && decoded.message
          ? { message: decoded.message as AgentEmailCursorPosition }
          : {}),
        thread: decoded.thread,
      };
    }
    const legacy = parseAgentEmailCursor(value);
    if (!legacy) throw new Error("invalid");
    return { kind: "after-thread", thread: legacy };
  } catch {
    throw new Error("Thread search cursor is invalid.");
  }
}

export const tableForEmailRecord = (itemType: PlatformRecord["itemType"]) =>
  ["inbox-attachment", "inbox-draft", "inbox-message", "inbox-thread"].includes(itemType)
    ? ("execution" as const)
    : ("control" as const);

export function apiError(status: number, code: string, message: string): never {
  throw new AgentEmailApiError(status, code, message);
}

export function requiredBody(invocation: AgentEmailApiInvocation) {
  return invocation.body ?? apiError(400, "invalid_request", "A request body is required.");
}

export function requiredParameter(invocation: AgentEmailApiInvocation, name: string) {
  const value =
    invocation.parameters[name] ?? apiError(400, "invalid_path_parameter", `${name} is required.`);
  try {
    Schema.decodeUnknownSync(PublicId)(value);
    return value;
  } catch {
    return apiError(400, "invalid_path_parameter", `${name} must be a canonical public ID.`);
  }
}

// Decode against the schemas published by @deployments-ai/api-contract so the
// hosted runtime and generated OpenAPI surface enforce the same constraints.
export function decodePublicRequest<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  strict = false,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(
      schema,
      strict ? { onExcessProperty: "error" } : undefined,
    )(value);
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : "";
    return apiError(400, "invalid_request", `The request is invalid.${detail}`);
  }
}

export function queryString(invocation: AgentEmailApiInvocation, name: string) {
  const value = invocation.query[name];
  return typeof value === "string" ? value : undefined;
}

export function queryLimit(invocation: AgentEmailApiInvocation) {
  const value = invocation.query.limit;
  if (value === undefined) return 50;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100) {
    apiError(400, "invalid_query", "limit must be an integer between 1 and 100.");
  }
  return value;
}

export function indexedPage<T>(
  items: readonly T[],
  result: {
    readonly hasMore: boolean;
    readonly scannedThrough:
      | {
          readonly data: { readonly createdAt: string; readonly id: string };
        }
      | undefined;
  },
) {
  return {
    items,
    ...(result.hasMore && result.scannedThrough
      ? {
          nextCursor: agentEmailCursor(
            result.scannedThrough.data.createdAt,
            result.scannedThrough.data.id,
          ),
        }
      : {}),
  };
}

export function validated<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof AgentEmailValidationError) {
      apiError(400, "invalid_request", cause.message);
    }
    throw cause;
  }
}

export function agentEmailCsvCell(value: unknown) {
  const text = String(value);
  const safe = /^[\t\n\r ]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

const INFRASTRUCTURE_FIELDS = ["environmentId", "projectId", "version", "workspaceId"] as const;

function withoutInfrastructure<T extends object, const K extends keyof T = never>(
  data: T,
  omitted: readonly K[] = [],
) {
  return definedFields(data, [...INFRASTRUCTURE_FIELDS, ...omitted]);
}

export function domainFrom(record: RecordOf<"inbox-domain">): AgentEmailDomainRecord {
  return {
    ...withoutInfrastructure(record.data, ["dnsRecords"]),
    dnsRecords: Schema.decodeUnknownSync(Schema.Array(AgentEmailDnsRecordSchema))(
      record.data.dnsRecords,
    ),
  };
}

export function inboxFrom(record: RecordOf<"inbox">): AgentEmailInboxRecord {
  return withoutInfrastructure(record.data, ["placementId"]);
}

export function bindingFrom(record: RecordOf<"inbox-binding">): AgentEmailInboxBindingRecord {
  return withoutInfrastructure(record.data, ["agentDefinitionId"]);
}

export function placementFrom(record: RecordOf<"inbox-placement">): AgentEmailPlacementRecord {
  return withoutInfrastructure(record.data);
}

export function attachmentFrom(record: RecordOf<"inbox-attachment">): AgentEmailAttachmentRecord {
  const data = record.data;
  return {
    byteSize: data.storage.byteSize,
    ...(data.contentId ? { contentId: data.contentId } : {}),
    contentType: data.contentType,
    disposition: data.disposition,
    fileName: data.fileName,
    id: data.id,
    messageId: data.inboxMessageId,
    sha256: data.sha256,
  };
}

export function messageFrom(
  record: RecordOf<"inbox-message">,
  attachments: readonly AgentEmailAttachmentRecord[] = [],
): AgentEmailMessageRecord {
  return {
    ...withoutInfrastructure(record.data, [
      "htmlBodyRef",
      "participantKeys",
      "priority",
      "rawPurgeClaimedAt",
      "rawPurgeClaimFingerprint",
      "rawPurgeClaimKey",
      "rawReference",
      "textBodyRef",
    ]),
    attachments,
  };
}

export function threadFrom(record: RecordOf<"inbox-thread">): AgentEmailThreadRecord {
  return withoutInfrastructure(record.data, ["clientId", "threadKey"]);
}

export function draftFrom(record: RecordOf<"inbox-draft">): AgentEmailDraftRecord {
  const data = withoutInfrastructure(record.data, [
    "htmlBodyRef",
    "participantKeys",
    "recipients",
    "textBodyRef",
  ]);
  return { ...data, toAddresses: [...record.data.recipients] };
}

export function policyFrom(record: RecordOf<"inbox-policy">): AgentEmailPolicyRecord {
  return withoutInfrastructure(record.data, [
    "bounceMessageCount",
    "complaintMessageCount",
    "inboxId",
    "outboundOutcomeMessageCount",
    "requireRecipientVerification",
  ]);
}

export function suppressionFrom(
  record: RecordOf<"inbox-suppression">,
): AgentEmailSuppressionRecord {
  return withoutInfrastructure(record.data, ["emailHash", "removedAt", "status", "updatedAt"]);
}

interface AgentEmailReprocessRequest {
  readonly message: AgentEmailMessageRecord;
  readonly reprocessId: string;
  readonly scope: AgentEmailApiScope;
}

interface AgentEmailProviderSuppressionSyncRequest {
  readonly message: AgentEmailMessageRecord;
  readonly removed: boolean;
  readonly scope: AgentEmailApiScope;
  readonly suppression: AgentEmailSuppressionRecord;
}

export interface AgentEmailRunnableDeployment {
  readonly agentDefinitionId: string;
}

export interface DynamoAgentEmailApplicationServiceDependencies {
  readonly blobs?: AgentEmailBlobStore;
  readonly blobBucket?: string;
  readonly createId?: () => Promise<string> | string;
  readonly database: DynamoDatabaseService;
  readonly endUserKeys: AgentEmailEndUserKeys;
  readonly defaultDomainId?: (
    scope: AgentEmailApiScope,
    domains: readonly AgentEmailDomainRecord[],
  ) => Promise<string | undefined> | string | undefined;
  readonly domainProvisioner?: AgentEmailDomainProvisioner;
  readonly enqueueReprocess?: (request: AgentEmailReprocessRequest) => Promise<void>;
  readonly hostedDomainRegion?: string;
  readonly now?: () => Date;
  readonly placementProvisioner?: AgentEmailPlacementProvisioner;
  readonly syncProviderSuppression?: (
    request: AgentEmailProviderSuppressionSyncRequest,
  ) => Promise<void>;
  readonly signedUrlTtlSeconds?: number;
  readonly validateAgentDeployment?: (
    scope: AgentEmailApiScope,
    agentDeploymentId: string,
  ) => Promise<AgentEmailRunnableDeployment | undefined>;
}

export function platformScope(scope: AgentEmailApiScope): AgentEmailPlatformScope {
  return {
    environmentId: scope.environmentId as Ulid,
    organizationId: scope.organizationId as Ulid,
    projectId: scope.projectId as Ulid,
  };
}

export function event(
  type:
    | "agent-email.domain-created"
    | "agent-email.domain-updated"
    | "agent-email.inbox-created"
    | "agent-email.inbox-updated"
    | "agent-email.send-requested",
  resource: AgentEmailDomainRecord | AgentEmailInboxRecord | AgentEmailMessageRecord,
  eventId: string,
  scope: AgentEmailApiScope,
  occurredAt: string,
) {
  if ("direction" in resource) {
    return buildAgentEmailDomainEvent({
      aggregateId: resource.id,
      eventId,
      eventType: type as "agent-email.send-requested",
      payload: {
        address: resource.fromAddress,
        context: {
          environmentId: scope.environmentId,
          projectId: scope.projectId,
        },
        direction: resource.direction,
        fromAddress: resource.fromAddress,
        inboxId: resource.inboxId,
        messageId: resource.id,
        occurredAt,
        organizationId: scope.organizationId,
        status: resource.status,
        subject: resource.subject,
        toAddresses: resource.toAddresses,
        version: 2,
      },
    });
  }
  const resourceType = "domain" in resource ? "domain" : "inbox";
  return buildAgentEmailDomainEvent({
    aggregateId: resource.id,
    eventId,
    eventType: type,
    payload: {
      context: {
        environmentId: scope.environmentId,
        projectId: scope.projectId,
      },
      occurredAt,
      organizationId: scope.organizationId,
      resourceId: resource.id,
      resourceType,
      status: resource.status,
      version: 1,
    },
  });
}
