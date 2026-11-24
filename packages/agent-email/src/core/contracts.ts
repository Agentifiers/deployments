import { Schema, SchemaGetter } from "effect";
import {
  AGENT_EMAIL_ATTACHMENT_DISPOSITIONS,
  AGENT_EMAIL_INBOX_STATUSES,
  AGENT_EMAIL_MESSAGE_STATUSES,
  AGENT_EMAIL_DIRECTIONS,
  AGENT_EMAIL_USAGE_BUCKETS,
} from "./models.ts";
import { AGENT_EMAIL_WARMUP_STAGES } from "./product.ts";

export const MAX_AGENT_EMAIL_ATTACHMENTS = 35;

export class CreateAgentEmailInboxRequest extends Schema.Class<CreateAgentEmailInboxRequest>(
  "CreateAgentEmailInboxRequest",
)({
  clientId: Schema.optional(Schema.String),
  domainId: Schema.optional(Schema.String),
  localPart: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  name: Schema.optional(Schema.String),
}) {}

export class UpdateAgentEmailInboxRequest extends Schema.Class<UpdateAgentEmailInboxRequest>(
  "UpdateAgentEmailInboxRequest",
)({
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(AGENT_EMAIL_INBOX_STATUSES)),
}) {}

const CreateAgentEmailBindingRequestSchema = Schema.Struct({
  agentDeploymentId: Schema.optional(Schema.String),
  bindingType: Schema.Literals(["external", "platform_agent"]),
  externalId: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).check(
  Schema.makeFilter<{
    readonly agentDeploymentId?: string | undefined;
    readonly bindingType: "external" | "platform_agent";
    readonly externalId?: string | undefined;
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  }>((input) => {
    if (input.bindingType === "platform_agent") {
      return input.agentDeploymentId?.trim()
        ? undefined
        : "agentDeploymentId is required for platform_agent bindings.";
    }
    return input.externalId?.trim() ? undefined : "externalId is required for external bindings.";
  }),
);

export class CreateAgentEmailBindingRequest extends Schema.Class<CreateAgentEmailBindingRequest>(
  "CreateAgentEmailBindingRequest",
)(CreateAgentEmailBindingRequestSchema) {}

export class CreateAgentEmailDomainRequest extends Schema.Class<CreateAgentEmailDomainRequest>(
  "CreateAgentEmailDomainRequest",
)({
  domain: Schema.String,
  placementId: Schema.optional(Schema.String),
}) {}

const AgentEmailAttachmentContentId = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(78), Schema.isPattern(/^[^\r\n]*$/u)),
);

const AgentEmailAttachmentContentType = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(78),
    Schema.isPattern(/^[^\s/;]+\/[^\s/;]+(?:\s*;\s*[^\r\n]+)?$/u),
  ),
);

const AgentEmailAttachmentFileName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(255), Schema.isPattern(/^[^\r\n]+$/u)),
);

export class AgentEmailAttachmentInput extends Schema.Class<AgentEmailAttachmentInput>(
  "AgentEmailAttachmentInput",
)({
  contentBase64: Schema.String,
  contentId: Schema.optional(AgentEmailAttachmentContentId),
  contentType: AgentEmailAttachmentContentType,
  disposition: Schema.optional(Schema.Literals(AGENT_EMAIL_ATTACHMENT_DISPOSITIONS)),
  fileName: AgentEmailAttachmentFileName,
}) {}

const AgentEmailAttachments = Schema.Array(AgentEmailAttachmentInput).check(
  Schema.isMaxLength(MAX_AGENT_EMAIL_ATTACHMENTS),
);

export class SendAgentEmailMessageRequest extends Schema.Class<SendAgentEmailMessageRequest>(
  "SendAgentEmailMessageRequest",
)({
  attachments: Schema.optional(AgentEmailAttachments),
  bcc: Schema.optional(Schema.Array(Schema.String)),
  cc: Schema.optional(Schema.Array(Schema.String)),
  clientId: Schema.optional(Schema.String),
  html: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  replyToMessageId: Schema.optional(Schema.String),
  scheduledAt: Schema.optional(Schema.String),
  subject: Schema.String,
  text: Schema.optional(Schema.String),
  to: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
}) {}

export class SearchAgentEmailMessagesRequest extends Schema.Class<SearchAgentEmailMessagesRequest>(
  "SearchAgentEmailMessagesRequest",
)({
  cursor: Schema.optional(Schema.String),
  direction: Schema.optional(Schema.Literals(AGENT_EMAIL_DIRECTIONS)),
  from: Schema.optional(Schema.String),
  hasAttachments: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
  participants: Schema.optional(Schema.Array(Schema.String)),
  query: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(AGENT_EMAIL_MESSAGE_STATUSES)),
  to: Schema.optional(Schema.String),
}) {}

export class SearchAgentEmailThreadsRequest extends Schema.Class<SearchAgentEmailThreadsRequest>(
  "SearchAgentEmailThreadsRequest",
)({
  cursor: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  hasAttachments: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
  participants: Schema.optional(Schema.Array(Schema.String)),
  query: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
}) {}

export class AgentEmailReplyRequest extends Schema.Class<AgentEmailReplyRequest>(
  "AgentEmailReplyRequest",
)({
  attachments: Schema.optional(AgentEmailAttachments),
  bcc: Schema.optional(Schema.Array(Schema.String)),
  cc: Schema.optional(Schema.Array(Schema.String)),
  html: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  scheduledAt: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
}) {}

export class AgentEmailForwardRequest extends Schema.Class<AgentEmailForwardRequest>(
  "AgentEmailForwardRequest",
)({
  attachments: Schema.optional(AgentEmailAttachments),
  bcc: Schema.optional(Schema.Array(Schema.String)),
  cc: Schema.optional(Schema.Array(Schema.String)),
  html: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  includeOriginal: Schema.optional(Schema.Boolean),
  scheduledAt: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  to: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
}) {}

export class ExportAgentEmailUsageRequest extends Schema.Class<ExportAgentEmailUsageRequest>(
  "ExportAgentEmailUsageRequest",
)({
  bucket: Schema.optional(Schema.Literals(AGENT_EMAIL_USAGE_BUCKETS)),
  format: Schema.optional(Schema.Literals(["csv", "json"])),
  from: Schema.optional(Schema.String),
  inboxId: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
}) {}

const AgentEmailRegion = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.pipe(
      Schema.check(
        Schema.makeFilter<string>((region) =>
          /^(?:[a-z0-9]+-)+[a-z0-9]+-\d+$/u.test(region)
            ? undefined
            : "Expected a normalized AWS region.",
        ),
      ),
    ),
    {
      decode: SchemaGetter.transform((region: string) => region.trim().toLowerCase()),
      encode: SchemaGetter.passthrough(),
    },
  ),
);

const CreateAgentEmailPlacementRequestSchema = Schema.Struct({
  dedicatedPool: Schema.optional(Schema.Boolean),
  isDefault: Schema.optional(Schema.Boolean),
  name: Schema.String,
  region: AgentEmailRegion,
  secondaryRegion: Schema.optional(AgentEmailRegion),
}).check(
  Schema.makeFilter<{
    readonly region: string;
    readonly secondaryRegion?: string | undefined;
  }>((input) =>
    input.secondaryRegion === input.region ? "secondaryRegion must differ from region." : undefined,
  ),
);

export class CreateAgentEmailPlacementRequest extends Schema.Class<CreateAgentEmailPlacementRequest>(
  "CreateAgentEmailPlacementRequest",
)(CreateAgentEmailPlacementRequestSchema) {
  constructor(props: {
    readonly dedicatedPool?: boolean;
    readonly isDefault?: boolean;
    readonly name: string;
    readonly region: string;
    readonly secondaryRegion?: string;
  }) {
    super({
      ...props,
      region: props.region.trim().toLowerCase(),
      ...(props.secondaryRegion === undefined
        ? {}
        : { secondaryRegion: props.secondaryRegion.trim().toLowerCase() }),
    });
  }
}

export class UpdateAgentEmailPlacementRequest extends Schema.Class<UpdateAgentEmailPlacementRequest>(
  "UpdateAgentEmailPlacementRequest",
)({
  dedicatedPool: Schema.optional(Schema.Boolean),
  isDefault: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["active", "disabled"])),
}) {}

export class CreateAgentEmailDraftRequest extends Schema.Class<CreateAgentEmailDraftRequest>(
  "CreateAgentEmailDraftRequest",
)({
  bcc: Schema.optional(Schema.Array(Schema.String)),
  cc: Schema.optional(Schema.Array(Schema.String)),
  clientId: Schema.optional(Schema.String),
  html: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  replyToMessageId: Schema.optional(Schema.String),
  scheduledAt: Schema.optional(Schema.String),
  subject: Schema.String,
  text: Schema.optional(Schema.String),
  to: Schema.Array(Schema.String),
}) {}

export class UpdateAgentEmailDraftRequest extends Schema.Class<UpdateAgentEmailDraftRequest>(
  "UpdateAgentEmailDraftRequest",
)({
  bcc: Schema.optional(Schema.Array(Schema.String)),
  cc: Schema.optional(Schema.Array(Schema.String)),
  html: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  scheduledAt: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  to: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class CreateAgentEmailSuppressionRequest extends Schema.Class<CreateAgentEmailSuppressionRequest>(
  "CreateAgentEmailSuppressionRequest",
)({
  address: Schema.String,
  reason: Schema.Literals(["manual", "policy"]),
}) {}

const AgentEmailNonNegativeSafeInteger = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Expected an integer." }),
    Schema.isGreaterThanOrEqualTo(0, {
      message: "Expected a non-negative value.",
    }),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER, {
      message: "Expected a safely representable integer.",
    }),
  ),
);

const AgentEmailBasisPoints = AgentEmailNonNegativeSafeInteger.pipe(
  Schema.check(
    Schema.isLessThanOrEqualTo(10_000, {
      message: "Basis points cannot exceed 10,000.",
    }),
  ),
);

const AgentEmailAttachmentByteLimit = AgentEmailNonNegativeSafeInteger.pipe(
  Schema.check(
    Schema.isLessThanOrEqualTo(4 * 1024 * 1024, {
      message: "Inline attachment limits cannot exceed 4 MiB.",
    }),
  ),
);

const AgentEmailRecipientLimit = AgentEmailNonNegativeSafeInteger.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(1, {
      message: "At least one recipient must be allowed.",
    }),
    Schema.isLessThanOrEqualTo(47, {
      message: "Recipient limits cannot exceed 47.",
    }),
  ),
);

const AgentEmailRawRetentionDays = AgentEmailNonNegativeSafeInteger.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(1, {
      message: "Raw retention must be at least one day.",
    }),
    Schema.isLessThanOrEqualTo(365, {
      message: "Raw retention cannot exceed 365 days.",
    }),
  ),
);

export class UpdateAgentEmailPolicyRequest extends Schema.Class<UpdateAgentEmailPolicyRequest>(
  "UpdateAgentEmailPolicyRequest",
)({
  allowlist: Schema.optional(Schema.Array(Schema.String)),
  blocklist: Schema.optional(Schema.Array(Schema.String)),
  bounceRateThresholdBasisPoints: Schema.optional(AgentEmailBasisPoints),
  complaintRateThresholdBasisPoints: Schema.optional(AgentEmailBasisPoints),
  dailyOutboundMessageLimit: Schema.optional(AgentEmailNonNegativeSafeInteger),
  maxAttachmentBytes: Schema.optional(AgentEmailAttachmentByteLimit),
  maxRecipientsPerMessage: Schema.optional(AgentEmailRecipientLimit),
  rawRetentionDays: Schema.optional(AgentEmailRawRetentionDays),
  sendingStatus: Schema.optional(Schema.Literals(["active", "paused"])),
  warmupStage: Schema.optional(Schema.Literals(AGENT_EMAIL_WARMUP_STAGES)),
}) {}

export class RejectAgentEmailDraftRequest extends Schema.Class<RejectAgentEmailDraftRequest>(
  "RejectAgentEmailDraftRequest",
)({
  reason: Schema.String,
}) {}

export interface AgentEmailSendQueueMessage {
  readonly environmentId: string;
  readonly inboxId: string;
  readonly messageId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly type: "agent-email-send";
}
