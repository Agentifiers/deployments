import type { Ulid } from "../ids.ts";
import type { DynamoValue } from "../record-schema.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";

export interface AgentEmailPlatformScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly workspaceId?: Ulid;
}

export interface AgentEmailAttachmentBlob {
  readonly bucket: string;
  readonly byteSize: number;
  readonly contentId?: string;
  readonly contentType: string;
  readonly disposition: "attachment" | "inline";
  readonly etag?: string;
  readonly fileName: string;
  readonly id: Ulid;
  readonly key: string;
  readonly sha256: string;
  readonly versionId?: string;
}

export interface AgentEmailContentCleanup {
  readonly createdAt: string;
  readonly id: Ulid;
  readonly references: readonly NonNullable<
    Extract<PlatformRecord, { readonly itemType: "inbox-message" }>["data"]["htmlBodyRef"]
  >[];
  readonly resourceId: Ulid;
  readonly resourceType: "draft" | "message";
}

export interface AgentEmailMessageBodyReferences {
  readonly htmlBodyRef?: Extract<
    PlatformRecord,
    { readonly itemType: "inbox-message" }
  >["data"]["htmlBodyRef"];
  readonly rawReference?: Extract<
    PlatformRecord,
    { readonly itemType: "inbox-message" }
  >["data"]["rawReference"];
  readonly textBodyRef?: Extract<
    PlatformRecord,
    { readonly itemType: "inbox-message" }
  >["data"]["textBodyRef"];
}

export interface AgentEmailDraftBodyReferences {
  readonly htmlBodyRef?: Extract<
    PlatformRecord,
    { readonly itemType: "inbox-draft" }
  >["data"]["htmlBodyRef"];
  readonly textBodyRef?: Extract<
    PlatformRecord,
    { readonly itemType: "inbox-draft" }
  >["data"]["textBodyRef"];
}

export interface AgentEmailPolicyReputationState {
  readonly bounceMessageCount?: number;
  readonly complaintMessageCount?: number;
  readonly outboundOutcomeMessageCount?: number;
}

export type RecordOf<ItemType extends PlatformRecord["itemType"]> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

export type AgentEmailControlResourceType =
  | "inbox"
  | "inbox-binding"
  | "inbox-domain"
  | "inbox-placement"
  | "inbox-suppression";

export const MAX_ACTIVE_AGENT_EMAIL_PLATFORM_BINDINGS_PER_INBOX = 100;

export class AgentEmailBindingLimitError extends Error {
  readonly inboxId: string;
  readonly limit: number;

  constructor(inboxId: string) {
    super(
      `Inbox ${inboxId} exceeds the active platform-agent binding limit of ${MAX_ACTIVE_AGENT_EMAIL_PLATFORM_BINDINGS_PER_INBOX}.`,
    );
    this.name = "AgentEmailBindingLimitError";
    this.inboxId = inboxId;
    this.limit = MAX_ACTIVE_AGENT_EMAIL_PLATFORM_BINDINGS_PER_INBOX;
  }
}

const MAX_THREAD_PARTICIPANTS = 256;
const MAX_THREAD_PARTICIPANTS_BYTES = 64 * 1024;

function takeBoundedThreadParticipants(participants: readonly string[]) {
  const selected: string[] = [];
  const seen = new Set<string>();
  let bytes = 2;
  for (const participant of participants) {
    if (seen.has(participant)) continue;
    const participantBytes = Buffer.byteLength(JSON.stringify(participant), "utf8") + 1;
    if (
      selected.length >= MAX_THREAD_PARTICIPANTS ||
      bytes + participantBytes > MAX_THREAD_PARTICIPANTS_BYTES
    ) {
      continue;
    }
    seen.add(participant);
    selected.push(participant);
    bytes += participantBytes;
  }
  return selected;
}

export function boundedAgentEmailThreadParticipants(
  participants: readonly string[],
  preferred: readonly string[] = [],
) {
  const unique = [...new Set(participants)];
  const bounded = takeBoundedThreadParticipants(unique);
  return bounded.length === unique.length
    ? bounded
    : takeBoundedThreadParticipants([...preferred, ...unique]);
}

export function record<ItemType extends PlatformRecord["itemType"]>(
  input: Omit<RecordOf<ItemType>, "gsi1pk" | "gsi1sk" | "gsi2pk" | "gsi2sk" | "pk" | "sk">,
) {
  return withCanonicalRecordKeys(input) as RecordOf<ItemType>;
}

export function base(scope: AgentEmailPlatformScope) {
  return {
    environmentId: scope.environmentId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
  };
}

function dynamoValue(value: unknown): DynamoValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined).map(dynamoValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, dynamoValue(entry)]),
    );
  }
  if (typeof value === "function" || typeof value === "symbol") return value.toString();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "undefined";
}

export function metadata(value: Readonly<Record<string, unknown>>) {
  return dynamoValue(value) as Readonly<Record<string, DynamoValue>>;
}
