import { createHmac } from "node:crypto";
import { Schema } from "effect";
import {
  EMAIL_END_USER_ID_PREFIX,
  emailAddressOfEndUserId,
  emailEndUserId,
} from "@deployments-ai/agent-email";
import { EndUserKey, type DynamoDatabaseService } from "@deployments-ai/db";
import {
  ConversationError,
  record,
  type ConversationThread,
  type SubmitConversationTurnInput,
} from "./submission.ts";

const END_USER_ID_MAX_LENGTH = 256;
const MIN_SUBJECT_KEY_BYTES = 32;
const CHANNEL_SUBJECT_PREFIX = "channel:";
const CONTROL_CHARACTERS = /\p{Cc}/u;
const END_USER_KEY_VERSION = "v1";
const decodeEndUserKey = Schema.decodeUnknownSync(EndUserKey);

export type EndUserKeyDeriver = (organizationId: string, endUserId: string) => EndUserKey;

export function parseEndUserId(
  value: unknown,
  purpose: "erasure" | "thread",
  field = "endUserId",
): string {
  const invalid = (reason: string) =>
    new ConversationError("invalid_request", `${field} ${reason}`);
  if (typeof value !== "string") throw invalid("must be a string.");
  const normalized = value.normalize("NFC");
  if (normalized.length === 0 || normalized.length > END_USER_ID_MAX_LENGTH) {
    throw invalid(`must hold 1 to ${END_USER_ID_MAX_LENGTH} characters.`);
  }
  if (normalized.trim() !== normalized) throw invalid("must not start or end with whitespace.");
  if (CONTROL_CHARACTERS.test(normalized)) throw invalid("must not contain control characters.");
  if (purpose === "thread" && normalized.startsWith(CHANNEL_SUBJECT_PREFIX)) {
    throw invalid(`must not start with "${CHANNEL_SUBJECT_PREFIX}", which names channel users.`);
  }
  if (!normalized.startsWith(EMAIL_END_USER_ID_PREFIX)) return normalized;
  const address = emailAddressOfEndUserId(normalized);
  if (!address) throw invalid(`must name an email address after "${EMAIL_END_USER_ID_PREFIX}".`);
  return emailEndUserId(address);
}

export function endUserKeyDeriver(secret: string): EndUserKeyDeriver {
  if (Buffer.byteLength(secret, "utf8") < MIN_SUBJECT_KEY_BYTES) {
    throw new Error(`The end-user subject key must hold at least ${MIN_SUBJECT_KEY_BYTES} bytes.`);
  }
  return (organizationId, endUserId) =>
    decodeEndUserKey(
      `${END_USER_KEY_VERSION}.${createHmac("sha256", secret)
        .update(`end-user-subject-${END_USER_KEY_VERSION}\u0000${organizationId}\u0000${endUserId}`)
        .digest("base64url")}`,
    );
}

export interface ChannelSubjectInput {
  readonly channel: string;
  readonly externalChannelId: string;
  readonly externalThreadKey: string;
  readonly externalWorkspaceId?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly provider: string;
  readonly senderId: string;
}

function isSinglePartyConversation(input: ChannelSubjectInput) {
  switch (input.channel) {
    case "imessage":
    case "rcs":
    case "sms":
      return true;
    case "slack":
      // Every Slack ingress kind (message, slash command, interaction) names the conversation id,
      // and only direct messages have `D` ids; Events API's `channel_type` is not on all of them.
      return input.externalChannelId.startsWith("D");
    case "teams":
      return input.metadata?.teamsConversationType === "personal";
    case "telegram":
      // The thread key is the Telegram chat id, which equals the sender's user id only in a
      // private chat; group ids are negative and channels post without a user sender.
      return input.externalThreadKey === input.senderId;
    default:
      return false;
  }
}

export function channelEndUserId(input: ChannelSubjectInput): string | undefined {
  if (!input.senderId || !isSinglePartyConversation(input)) return undefined;
  const workspace = input.externalWorkspaceId ? encodeURIComponent(input.externalWorkspaceId) : "-";
  return `${CHANNEL_SUBJECT_PREFIX}${input.provider}:${workspace}:${encodeURIComponent(input.senderId)}`;
}

function subjectMismatch() {
  return new ConversationError(
    "end_user_mismatch",
    "The thread already belongs to a different end user, or to none.",
  );
}

export async function submittedThreadSubject(
  database: DynamoDatabaseService,
  input: SubmitConversationTurnInput,
  previousThread: ConversationThread | undefined,
): Promise<EndUserKey | undefined> {
  if (previousThread) {
    if (input.endUserKey && input.endUserKey !== previousThread.data.endUserKey) {
      throw subjectMismatch();
    }
    return previousThread.data.endUserKey;
  }
  const parentThreadId = input.traceContext?.parentThreadId;
  const parent = parentThreadId
    ? await record(database, {
        kind: "thread",
        organizationId: input.organizationId,
        threadId: parentThreadId,
      })
    : undefined;
  const inherited = parent?.itemType === "thread" ? parent.data.endUserKey : undefined;
  if (input.endUserKey && inherited && input.endUserKey !== inherited) throw subjectMismatch();
  return input.endUserKey ?? inherited;
}
