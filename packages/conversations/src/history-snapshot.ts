import {
  key,
  makeConversationMessagePublicationPersistence,
  makeConversationPersistence,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import type { ThreadStreamScope } from "@deployments-ai/streaming";
import { leaseIsMessagePublicationBarrier } from "./message-publication-state.ts";
import { ConversationError, expected } from "./submission.ts";

const MAX_HISTORY_SNAPSHOT_ATTEMPTS = 3;

export async function conversationHistorySnapshot(
  database: DynamoDatabaseService,
  scope: ThreadStreamScope,
) {
  const persistence = makeConversationPersistence(database);
  const publicationPersistence = makeConversationMessagePublicationPersistence(database);
  for (let attempt = 0; attempt < MAX_HISTORY_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = expected(
      await persistence.get({
        kind: "thread",
        organizationId: scope.organizationId,
        threadId: scope.threadId,
      }),
      "thread",
      "Thread",
    );
    if (
      before.data.environmentId !== scope.environmentId ||
      before.data.projectId !== scope.projectId
    ) {
      throw new ConversationError("scope_mismatch", "Thread does not match the history scope.");
    }
    const barrierBefore = await publicationPersistence.loadThreadExecutionLease(scope.threadId);
    if (leaseIsMessagePublicationBarrier(barrierBefore)) {
      throw new ConversationError(
        "publication_busy",
        "Conversation history is waiting for an external delivery outcome.",
      );
    }
    const [afterValue, barrierAfter] = await Promise.all([
      persistence.get({
        kind: "thread",
        organizationId: scope.organizationId,
        threadId: scope.threadId,
      }),
      publicationPersistence.loadThreadExecutionLease(scope.threadId),
    ]);
    const after = expected(afterValue, "thread", "Thread");
    if (leaseIsMessagePublicationBarrier(barrierAfter)) {
      throw new ConversationError(
        "publication_busy",
        "Conversation history is waiting for an external delivery outcome.",
      );
    }
    if (before.data.version !== after.data.version) continue;
    return {
      throughSequence: after.data.version,
      upperSk: key("MESSAGE", String(after.data.version).padStart(16, "0"), "~"),
    };
  }
  throw new ConversationError(
    "publication_busy",
    "Conversation history changed while its snapshot was being prepared.",
  );
}
