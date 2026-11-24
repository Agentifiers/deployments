import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { internetMessageIdHash } from "../thread-erasure/record-keys.ts";

export type InboxThreadForThreadKey =
  | { readonly inboxThreadId: Ulid; readonly kind: "live" }
  | { readonly inboxThreadId: Ulid; readonly kind: "fenced" }
  | { readonly kind: "absent" };

export async function inboxThreadForThreadKey(
  database: DynamoDatabaseService,
  input: { readonly inboxId: string; readonly organizationId: string; readonly threadKey: string },
): Promise<InboxThreadForThreadKey> {
  const { inboxId, organizationId } = input;
  const internetMessageId = input.threadKey.trim();
  const read = async (itemType: string, identity: Readonly<Record<string, string>>) => {
    const { pk, sk } = withCanonicalRecordKeys({
      data: { ...identity, inboxId, organizationId },
      itemType,
    });
    return database.getRecord("execution", { pk, sk }, true);
  };
  const alias = await read("inbox-message-thread-alias", { internetMessageId });
  if (alias?.itemType === "inbox-message-thread-alias") {
    if (
      alias.data.organizationId !== organizationId ||
      alias.data.inboxId !== inboxId ||
      alias.data.internetMessageId !== internetMessageId
    ) {
      throw new Error("Inbound email thread alias does not match its canonical inbox scope.");
    }
    return { inboxThreadId: alias.data.threadId, kind: "live" };
  }
  const tombstone = await read("inbox-message-thread-alias-tombstone", {
    internetMessageIdHash: internetMessageIdHash(internetMessageId),
  });
  return tombstone?.itemType === "inbox-message-thread-alias-tombstone"
    ? { inboxThreadId: tombstone.data.inboxThreadId, kind: "fenced" }
    : { kind: "absent" };
}
