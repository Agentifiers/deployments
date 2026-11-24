import { correspondentAddresses, emailEndUserId } from "@deployments-ai/agent-email";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { EndUserKey, InboxMailResourceType } from "../records/conversation-erasure.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import type { AgentEmailPlatformScope } from "./record-mapping.ts";

export type AgentEmailEndUserKeys = (organizationId: string, endUserId: string) => EndUserKey;

type EndUserInboxMail = Extract<PlatformRecord, { readonly itemType: "end-user-inbox-mail" }>;

export interface InboxMailResource {
  readonly createdAt: string;
  readonly inboxId: string;
  readonly resourceId: string;
  readonly resourceType: InboxMailResourceType;
}

export function messageAddresses(message: {
  readonly bccAddresses: readonly string[];
  readonly ccAddresses: readonly string[];
  readonly fromAddress: string;
  readonly replyToAddresses: readonly string[];
  readonly toAddresses: readonly string[];
}) {
  return [
    message.fromAddress,
    ...message.toAddresses,
    ...message.ccAddresses,
    ...message.bccAddresses,
    ...message.replyToAddresses,
  ];
}

export type MailParticipants =
  | { readonly keys: readonly EndUserKey[]; readonly kind: "unchanged" }
  | {
      readonly keys: readonly EndUserKey[];
      readonly kind: "rekeyed";
      readonly stale: readonly EndUserKey[];
    };

export interface AgentEmailMailSubjects {
  readonly participantsFor: (
    inboxId: string,
    addresses: readonly string[],
  ) => Promise<MailParticipants>;
  readonly rekey: (
    inboxId: string,
    previous: { readonly addresses: readonly string[]; readonly keys: readonly EndUserKey[] },
    addresses: readonly string[],
  ) => Promise<MailParticipants>;
  readonly writeIndexed: <Written>(
    resource: InboxMailResource,
    participants: MailParticipants,
    write: () => Promise<Written>,
  ) => Promise<Written>;
}

export function endUserInboxMailRecord(
  scope: AgentEmailPlatformScope,
  resource: InboxMailResource,
  endUserKey: EndUserKey,
): EndUserInboxMail {
  return withCanonicalRecordKeys({
    data: {
      createdAt: resource.createdAt,
      endUserKey,
      environmentId: scope.environmentId,
      inboxId: resource.inboxId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
    },
    itemType: "end-user-inbox-mail" as const,
  }) as EndUserInboxMail;
}

export function makeAgentEmailMailSubjects(
  database: DynamoDatabaseService,
  scope: AgentEmailPlatformScope,
  inboxAddress: (inboxId: string) => Promise<string | undefined>,
  endUserKeys: AgentEmailEndUserKeys | undefined,
): AgentEmailMailSubjects {
  async function keysFor(inboxId: string, addresses: readonly string[]) {
    if (!endUserKeys) {
      throw new Error("Writing mail correspondents requires the end-user subject key.");
    }
    const ownAddress = await inboxAddress(inboxId);
    const correspondents = correspondentAddresses(addresses, ownAddress ? [ownAddress] : []);
    return [
      ...new Set(
        correspondents.map((address) => endUserKeys(scope.organizationId, emailEndUserId(address))),
      ),
    ].sort();
  }

  async function index(resource: InboxMailResource, keys: readonly EndUserKey[]) {
    for (const endUserKey of keys) {
      const row = endUserInboxMailRecord(scope, resource, endUserKey);
      const rowKey = { pk: row.pk, sk: row.sk };
      if (await database.getRecord("control", rowKey, true)) continue;
      try {
        await database.transactWrite([{ kind: "put", record: row }]);
      } catch (cause) {
        if (isDatabaseWriteConflict(cause)) continue;
        if (!(await database.getRecord("control", rowKey, true))) throw cause;
      }
    }
  }

  async function unindex(resource: InboxMailResource, keys: readonly EndUserKey[]) {
    for (const endUserKey of keys) {
      const expected = endUserInboxMailRecord(scope, resource, endUserKey);
      const row = await database.getRecord("control", { pk: expected.pk, sk: expected.sk });
      if (row?.itemType === "end-user-inbox-mail") {
        await database.transactWrite([{ kind: "delete", record: row }]);
      }
    }
  }

  return {
    async participantsFor(inboxId, addresses) {
      return { keys: await keysFor(inboxId, addresses), kind: "rekeyed", stale: [] };
    },
    async rekey(inboxId, previous, addresses) {
      if (
        correspondentAddresses(previous.addresses).join("\n") ===
        correspondentAddresses(addresses).join("\n")
      ) {
        return { keys: previous.keys, kind: "unchanged" };
      }
      const keys = await keysFor(inboxId, addresses);
      return { keys, kind: "rekeyed", stale: previous.keys.filter((key) => !keys.includes(key)) };
    },
    async writeIndexed(resource, participants, write) {
      if (participants.kind === "unchanged") return write();
      await index(resource, participants.keys);
      const written = await write();
      await unindex(resource, participants.stale);
      return written;
    },
  };
}
