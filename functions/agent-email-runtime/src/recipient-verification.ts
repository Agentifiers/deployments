import {
  Keys,
  type DynamoDatabaseService,
  type PlatformRecord,
  agentEmailPersistence,
} from "@deployments-ai/db";

interface AgentEmailRecipientScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

type InboxRecord = Extract<PlatformRecord, { readonly itemType: "inbox" }>;

async function getRecord(
  database: DynamoDatabaseService,
  table: Parameters<DynamoDatabaseService["getRecord"]>[0],
  key: { readonly pk: string; readonly sk: string },
) {
  return agentEmailPersistence.read(database, table, key, true);
}

export async function activeInboxForRecipient(
  database: DynamoDatabaseService,
  scope: AgentEmailRecipientScope,
  recipient: string,
  senderDomainId: string,
): Promise<InboxRecord | undefined> {
  const address = recipient.trim().toLowerCase();
  const claim = await getRecord(
    database,
    "control",
    Keys.control.uniqueClaim("inbox-address", address),
  );
  if (
    claim?.itemType !== "unique-claim" ||
    claim.data.ownerItemType !== "inbox" ||
    claim.data.ownerTable !== "control" ||
    claim.data.value.trim().toLowerCase() !== address
  ) {
    return undefined;
  }
  const inbox = await getRecord(database, "control", {
    pk: claim.data.ownerPk,
    sk: claim.data.ownerSk,
  });
  if (
    inbox?.itemType !== "inbox" ||
    inbox.data.address.trim().toLowerCase() !== address ||
    inbox.data.domainId !== senderDomainId ||
    inbox.data.environmentId !== scope.environmentId ||
    inbox.data.organizationId !== scope.organizationId ||
    inbox.data.projectId !== scope.projectId ||
    inbox.data.status !== "active"
  ) {
    return undefined;
  }
  return inbox;
}
