import type { DynamoValue } from "./record-schema.ts";

const CONVERSATION_VISIBILITY_METADATA_KEY = "deploymentsAiConversationVisibility";
const TRANSIENT_CONVERSATION_VISIBILITY = "transient";
const CONVERSATION_REPLAY_METADATA_KEY = "deploymentsAiConversationReplay";
const EXCLUDED_CONVERSATION_REPLAY = "excluded";

export function transientConversationMessageMetadata(
  metadata: Readonly<Record<string, DynamoValue>> = {},
): Readonly<Record<string, DynamoValue>> {
  return {
    ...metadata,
    [CONVERSATION_VISIBILITY_METADATA_KEY]: TRANSIENT_CONVERSATION_VISIBILITY,
  };
}

export function conversationMessageIsTransient(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>)[CONVERSATION_VISIBILITY_METADATA_KEY] ===
      TRANSIENT_CONVERSATION_VISIBILITY
  );
}

export function nonReplayableConversationMessageMetadata(
  metadata: Readonly<Record<string, DynamoValue>> = {},
): Readonly<Record<string, DynamoValue>> {
  return {
    ...metadata,
    [CONVERSATION_REPLAY_METADATA_KEY]: EXCLUDED_CONVERSATION_REPLAY,
  };
}

export function conversationMessageIsNonReplayable(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>)[CONVERSATION_REPLAY_METADATA_KEY] ===
      EXCLUDED_CONVERSATION_REPLAY
  );
}

export function visibleConversationMessageMetadata(
  metadata: Readonly<Record<string, DynamoValue>> | undefined,
): Readonly<Record<string, DynamoValue>> {
  if (!metadata) return {};
  const { [CONVERSATION_VISIBILITY_METADATA_KEY]: _visibility, ...visible } = metadata;
  return visible;
}
