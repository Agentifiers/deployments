import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  buildAgentEmailDomainEvent,
  type AgentEmailAttachmentRecord,
  type AgentEmailMessageRecord,
} from "@deployments-ai/agent-email";
import {
  agentEmailTenantNameForRegions,
  deterministicAgentEmailUlid,
  makeAgentEmailAwsRuntime,
} from "@deployments-ai/agent-email/aws";
import {
  Keys,
  makeAgentEmailDynamoRepository,
  makeDynamoDatabase,
  makeOrganizationHoldReader,
  tableNamesFromEnvironment,
  withCanonicalRecordKeys,
  type AgentEmailMessageBodyReferenceUpdate,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid as UlidValue,
  agentEmailPersistence,
} from "@deployments-ai/db";
import { admitConsistently } from "@deployments-ai/organization-admission";
import { createHash } from "node:crypto";

const BUCKET_ENV = "DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET";
const EVENTS_QUEUE_URL_ENV = "DEPLOYMENTS_AI_AGENT_EMAIL_EVENTS_QUEUE_URL";
const SEND_QUEUE_URL_ENV = "DEPLOYMENTS_AI_AGENT_EMAIL_SEND_QUEUE_URL";

import {
  agentEmailClaimOperationLimitFailure,
  agentEmailDispatchLimitFailure,
  decodeAgentEmailSendQueueMessage,
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_TRANSACTIONAL_RECIPIENTS,
  processAgentEmailSend,
  type AgentEmailSendMainDependencies,
  type AgentEmailSendQueueEvent,
  type LoadedAgentEmailSend,
} from "./send-processing.ts";
import { required } from "./runtime-input-validation.ts";
export * from "./send-persistence.ts";
export * from "./send-processing.ts";

import {
  agentEmailSendPrerequisiteConditionCheck,
  getRecord,
  inScope,
  messageModel,
  policyConditionCheck,
  policyVersionConditionCheck,
  queryAll,
  recipientInboxConditionCheck,
  suppressionClaimChecks,
  verificationConditionCheck,
} from "./send-persistence.ts";
import { activeInboxForRecipient } from "./recipient-verification.ts";
import { legacyAgentEmailBuckets } from "./legacy-buckets.ts";
import { definedFields } from "./record-fields.ts";

export function createAwsAgentEmailSendDependencies(
  environment: NodeJS.ProcessEnv = process.env,
  database: DynamoDatabaseService = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(environment),
  ),
): AgentEmailSendMainDependencies {
  const bucket = required(environment, BUCKET_ENV);
  const eventsQueueUrl = required(environment, EVENTS_QUEUE_URL_ENV);
  const sendQueueUrl = required(environment, SEND_QUEUE_URL_ENV);
  const storageRegion = required(environment, "AWS_REGION");
  const legacyBuckets = legacyAgentEmailBuckets(environment);
  const bucketAllowed = (candidate: string) =>
    candidate === bucket || legacyBuckets.includes(candidate);

  return {
    createEventId: (occurredAt, command) =>
      deterministicAgentEmailUlid(
        occurredAt,
        "send-result-v1",
        command.organizationId,
        command.inboxId,
        command.messageId,
      ),
    async load(command) {
      const persistedMessage = await getRecord(database, "execution", {
        pk: `ORG#${command.organizationId}#INBOX#${command.inboxId}`,
        sk: `INBOX-MESSAGE#${command.messageId}`,
      });
      if (!persistedMessage) return { kind: "erased" };
      if (persistedMessage.itemType !== "inbox-message" || !inScope(persistedMessage, command)) {
        throw new Error("Agent email message is outside the queued scope.");
      }
      let currentMessage = persistedMessage;
      const repository = makeAgentEmailDynamoRepository(database, {
        environmentId: command.environmentId as UlidValue,
        organizationId: command.organizationId as UlidValue,
        projectId: command.projectId as UlidValue,
      });
      const update = async (
        next: AgentEmailMessageRecord,
        event: ReturnType<typeof buildAgentEmailDomainEvent>,
        prerequisites: readonly TransactionOperation[] = [],
      ) => {
        const bodyReferences = {
          ...(currentMessage.data.htmlBodyRef
            ? { htmlBodyRef: currentMessage.data.htmlBodyRef }
            : {}),
          ...(currentMessage.data.textBodyRef
            ? { textBodyRef: currentMessage.data.textBodyRef }
            : {}),
        } satisfies AgentEmailMessageBodyReferenceUpdate;
        await repository.updateMessage(
          currentMessage,
          next,
          event,
          bodyReferences,
          undefined,
          undefined,
          prerequisites,
        );
      };
      const ineligible = (
        failureCode: string,
        failureReason: string,
        prerequisites: readonly TransactionOperation[] = [],
      ): LoadedAgentEmailSend => ({
        claim: async () => {
          throw new Error("An ineligible agent email cannot be claimed.");
        },
        command,
        ineligibility: {
          failureCode,
          failureReason,
          ...(prerequisites.length > 0 ? { prerequisites } : {}),
        },
        kind: "found",
        message: messageModel(persistedMessage, [], {}),
        release: async () => {
          throw new Error("An ineligible agent email has no send lease.");
        },
        send: async () => {
          throw new Error("An ineligible agent email cannot be sent.");
        },
        update,
      });
      const { decision: standing } = await admitConsistently({
        activity: "outbound.deliver",
        organizationId: command.organizationId as UlidValue,
        standing: makeOrganizationHoldReader(database),
      });
      if (standing.kind === "suspended") {
        return ineligible("organization_suspended", "The organization is suspended.");
      }
      const environmentRecord = await getRecord(database, "control", {
        pk: `ORG#${command.organizationId}#PROJECT#${command.projectId}`,
        sk: `ENVIRONMENT#${command.environmentId}`,
      });
      if (
        environmentRecord?.itemType !== "environment" ||
        !inScope(environmentRecord, command) ||
        environmentRecord.data.status !== "active"
      ) {
        return ineligible(
          "send_prerequisite_inactive",
          "The environment is no longer active for agent email sending.",
        );
      }
      const inbox = await getRecord(database, "control", {
        pk: `ORG#${command.organizationId}#INBOX#${command.inboxId}`,
        sk: `INBOX#${command.inboxId}`,
      });
      if (
        inbox?.itemType !== "inbox" ||
        !inScope(inbox, command) ||
        inbox.data.status !== "active"
      ) {
        return ineligible(
          "send_prerequisite_inactive",
          "The inbox is no longer active for agent email sending.",
        );
      }
      const domain = await getRecord(database, "control", {
        pk: `ORG#${command.organizationId}#ENV#${command.environmentId}`,
        sk: `INBOX-DOMAIN#${inbox.data.domainId}`,
      });
      if (
        domain?.itemType !== "inbox-domain" ||
        !inScope(domain, command) ||
        domain.data.status !== "verified"
      ) {
        return ineligible(
          "send_prerequisite_inactive",
          "The inbox domain is no longer verified for agent email sending.",
        );
      }
      const policies = (
        await queryAll(database, "control", {
          ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
          ExpressionAttributeValues: {
            ":pk": `ENV#${command.environmentId}`,
            ":sk": "INBOX-POLICY#",
          },
          IndexName: "gsi2",
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        })
      ).filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "inbox-policy" }> =>
          record.itemType === "inbox-policy" && inScope(record, command),
      );
      const inboxPolicies = policies.filter((policy) => policy.data.inboxId === command.inboxId);
      const environmentPolicies = policies.filter((policy) => !policy.data.inboxId);
      const effectivePolicies = inboxPolicies.length > 0 ? inboxPolicies : environmentPolicies;
      if (effectivePolicies.length > 1) {
        throw new Error("Agent email message resolves more than one outbound policy.");
      }
      const selectedPolicy = effectivePolicies[0]
        ? await getRecord(database, "control", {
            pk: effectivePolicies[0].pk,
            sk: effectivePolicies[0].sk,
          })
        : undefined;
      const policy =
        selectedPolicy?.itemType === "inbox-policy" &&
        inScope(selectedPolicy, command) &&
        selectedPolicy.data.inboxId === effectivePolicies[0]?.data.inboxId
          ? selectedPolicy
          : undefined;
      if (effectivePolicies[0] && !policy) {
        throw new Error("Agent email outbound policy changed during loading.");
      }
      if (policy && policy.data.sendingStatus !== "active") {
        return ineligible(
          "send_policy_inactive",
          "The outbound sending policy is no longer active.",
        );
      }
      const recipientAddresses = [
        ...new Set(
          [
            ...persistedMessage.data.toAddresses,
            ...persistedMessage.data.ccAddresses,
            ...persistedMessage.data.bccAddresses,
          ].map((address) => address.trim().toLowerCase()),
        ),
      ];
      const recipientLimit = Math.min(
        MAX_TRANSACTIONAL_RECIPIENTS,
        policy?.data.maxRecipientsPerMessage ?? MAX_TRANSACTIONAL_RECIPIENTS,
      );
      const recipientLimitFailure = agentEmailDispatchLimitFailure(
        "recipients",
        recipientAddresses.length,
        recipientLimit,
      );
      if (recipientLimitFailure) {
        return ineligible(
          recipientLimitFailure.failureCode,
          recipientLimitFailure.failureReason,
          policy ? [policyVersionConditionCheck(policy)] : [],
        );
      }
      const blockedAddresses = new Set(
        (policy?.data.blocklist ?? []).map((address) => address.trim().toLowerCase()),
      );
      if (recipientAddresses.some((address) => blockedAddresses.has(address))) {
        return ineligible(
          "recipient_blocked",
          "A recipient is blocked by the current outbound policy.",
        );
      }
      const requireRecipientVerification = policy?.data.requireRecipientVerification ?? true;
      const allowedAddresses = new Set(
        (policy?.data.allowlist ?? []).map((address) => address.trim().toLowerCase()),
      );
      const recipientVerifications = requireRecipientVerification
        ? (
            await queryAll(database, "control", {
              ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
              ExpressionAttributeValues: {
                ":pk": `ENV#${command.environmentId}`,
                ":sk": "INBOX-RECIPIENT-VERIFICATION#",
              },
              IndexName: "gsi2",
              KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
            })
          ).filter(
            (
              record,
            ): record is Extract<
              PlatformRecord,
              { readonly itemType: "inbox-recipient-verification" }
            > => record.itemType === "inbox-recipient-verification" && inScope(record, command),
          )
        : [];
      const verifiedRecipientInboxes = new Map<
        string,
        NonNullable<Awaited<ReturnType<typeof activeInboxForRecipient>>>
      >();
      if (requireRecipientVerification) {
        await Promise.all(
          recipientAddresses.map(async (address) => {
            if (allowedAddresses.has(address)) return;
            const recipientInbox = await activeInboxForRecipient(
              database,
              command,
              address,
              inbox.data.domainId,
            );
            if (recipientInbox) verifiedRecipientInboxes.set(address, recipientInbox);
          }),
        );
      }
      const unverifiedRecipient = requireRecipientVerification
        ? recipientAddresses.find((address) => {
            if (allowedAddresses.has(address)) return false;
            if (verifiedRecipientInboxes.has(address)) return false;
            return !recipientVerifications.some(
              (candidate) =>
                candidate.data.address.trim().toLowerCase() === address &&
                candidate.data.status === "verified" &&
                (!candidate.data.expiresAt || candidate.data.expiresAt > new Date().toISOString()),
            );
          })
        : undefined;
      if (unverifiedRecipient) {
        return ineligible(
          "recipient_unverified",
          `Recipient ${unverifiedRecipient} is no longer verified for warmup sending.`,
        );
      }
      const recipientVerificationChecks = (observedAt: string) => {
        const checks: TransactionOperation[] = [];
        if (!requireRecipientVerification) return checks;
        for (const address of recipientAddresses) {
          if (allowedAddresses.has(address)) continue;
          const verification = recipientVerifications.find(
            (candidate) =>
              candidate.data.address.trim().toLowerCase() === address &&
              candidate.data.status === "verified" &&
              (!candidate.data.expiresAt || candidate.data.expiresAt > observedAt),
          );
          const recipientInbox = verifiedRecipientInboxes.get(address);
          if (!verification && !recipientInbox) {
            throw new Error(`Agent email recipient ${address} is not verified for warmup sending.`);
          }
          const recipientCondition = recipientInbox
            ? recipientInboxConditionCheck(recipientInbox, inbox)
            : undefined;
          if (verification) checks.push(verificationConditionCheck(verification));
          else if (recipientCondition) checks.push(recipientCondition);
        }
        return checks;
      };
      const claimLimitFailure = agentEmailClaimOperationLimitFailure(
        recipientAddresses.length,
        recipientVerificationChecks(new Date().toISOString()).length,
      );
      if (claimLimitFailure) {
        return ineligible(claimLimitFailure.failureCode, claimLimitFailure.failureReason);
      }
      const suppressionNamespace = `organization:${command.organizationId}:project:${command.projectId}:environment:${command.environmentId}:inbox-suppression`;
      const suppressionClaims = await Promise.all(
        recipientAddresses.map((address) =>
          getRecord(
            database,
            "control",
            Keys.control.uniqueClaim(
              suppressionNamespace,
              createHash("sha256").update(address).digest("hex"),
            ),
          ),
        ),
      );
      if (suppressionClaims.some((claim) => claim?.itemType === "unique-claim")) {
        return ineligible(
          "recipient_suppressed",
          "A recipient is now present on the environment suppression list.",
        );
      }
      const placements = (
        await queryAll(database, "control", {
          ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
          ExpressionAttributeValues: {
            ":pk": `ENV#${command.environmentId}`,
            ":sk": "INBOX-PLACEMENT#",
          },
          IndexName: "gsi2",
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        })
      ).filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "inbox-placement" }> =>
          record.itemType === "inbox-placement" && inScope(record, command),
      );
      const selectedPlacements = inbox.data.placementId
        ? placements.filter((placement) => placement.data.id === inbox.data.placementId)
        : placements.filter((placement) => placement.data.isDefault);
      if (selectedPlacements.length !== 1 || selectedPlacements[0]!.data.status !== "active") {
        return ineligible(
          "send_placement_inactive",
          "The inbox no longer resolves exactly one active SES placement.",
        );
      }
      const placement = selectedPlacements[0]!;
      if (placement.data.provider !== "ses") {
        throw new Error("Agent email placement provider does not match the SES worker.");
      }
      const configurationSetName = placement.data.providerMetadata.configurationSetName;
      const endpointId = placement.data.providerMetadata.endpointId;
      if (
        typeof configurationSetName !== "string" ||
        !configurationSetName.trim() ||
        (placement.data.secondaryRegion && (typeof endpointId !== "string" || !endpointId.trim()))
      ) {
        throw new Error("Agent email placement is missing its SES sending configuration.");
      }
      const regions = [
        placement.data.region,
        ...(placement.data.secondaryRegion ? [placement.data.secondaryRegion] : []),
      ];
      const tenantName = domain.data.providerManaged
        ? undefined
        : agentEmailTenantNameForRegions(
            (
              await queryAll(database, "control", {
                ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
                ExpressionAttributeValues: {
                  ":pk": `ORG#${command.organizationId}`,
                  ":sk": "INBOX-PROVIDER-TENANT#",
                },
                IndexName: "gsi1",
                KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
              })
            )
              .filter(
                (
                  record,
                ): record is Extract<
                  PlatformRecord,
                  { readonly itemType: "inbox-provider-tenant" }
                > =>
                  record.itemType === "inbox-provider-tenant" &&
                  record.data.organizationId === command.organizationId &&
                  record.data.provider === "ses" &&
                  regions.includes(record.data.region),
              )
              .map((tenant) => definedFields(tenant.data)),
            regions,
          );
      const attachmentRecords = (
        await queryAll(database, "execution", {
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": `ORG#${command.organizationId}#INBOX-MESSAGE#${command.messageId}`,
            ":sk": "INBOX-ATTACHMENT#",
          },
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        })
      ).filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "inbox-attachment" }> =>
          record.itemType === "inbox-attachment" &&
          inScope(record, command) &&
          record.data.inboxMessageId === command.messageId,
      );
      const attachmentLimit = Math.min(
        MAX_INLINE_ATTACHMENT_BYTES,
        policy?.data.maxAttachmentBytes ?? MAX_INLINE_ATTACHMENT_BYTES,
      );
      const attachmentLimitFailure = agentEmailDispatchLimitFailure(
        "attachments",
        attachmentRecords.reduce((total, record) => total + record.data.storage.byteSize, 0),
        attachmentLimit,
      );
      if (attachmentLimitFailure) {
        return ineligible(
          attachmentLimitFailure.failureCode,
          attachmentLimitFailure.failureReason,
          policy ? [policyVersionConditionCheck(policy)] : [],
        );
      }
      const aws = makeAgentEmailAwsRuntime({
        bucket,
        configurationSetName,
        ...(typeof endpointId === "string" ? { endpointId } : {}),
        eventsQueueUrl,
        legacyBuckets,
        loadAttachment: async (attachment) => {
          const stored = attachmentRecords.find((record) => record.data.id === attachment.id);
          if (!stored || !bucketAllowed(stored.data.storage.bucket)) {
            throw new Error("Agent email attachment storage does not match the configured bucket.");
          }
          return aws.blobs.get(
            stored.data.storage.key,
            stored.data.storage.versionId,
            stored.data.storage.bucket,
          );
        },
        region: placement.data.region,
        sendQueueUrl,
        storageRegion,
        ...(tenantName ? { tenantName } : {}),
      });
      const attachments: AgentEmailAttachmentRecord[] = attachmentRecords.map((record) => ({
        byteSize: record.data.storage.byteSize,
        ...(record.data.contentId ? { contentId: record.data.contentId } : {}),
        contentType: record.data.contentType,
        disposition: record.data.disposition,
        fileName: record.data.fileName,
        id: record.data.id,
        messageId: command.messageId,
        sha256: record.data.sha256,
      }));
      const loadBody = async (reference: NonNullable<typeof persistedMessage.data.htmlBodyRef>) => {
        if (!bucketAllowed(reference.bucket)) {
          throw new Error("Agent email body storage does not match the configured bucket.");
        }
        return new TextDecoder().decode(
          await aws.blobs.get(reference.key, reference.versionId, reference.bucket),
        );
      };
      const message = messageModel(persistedMessage, attachments, {
        ...(persistedMessage.data.htmlBodyRef
          ? {
              htmlBody: await loadBody(persistedMessage.data.htmlBodyRef),
            }
          : persistedMessage.data.htmlBody !== undefined
            ? { htmlBody: persistedMessage.data.htmlBody }
            : {}),
        ...(persistedMessage.data.textBodyRef
          ? {
              textBody: await loadBody(persistedMessage.data.textBodyRef),
            }
          : persistedMessage.data.textBody !== undefined
            ? { textBody: persistedMessage.data.textBody }
            : {}),
      });
      return {
        claim: async (claimedAt) => {
          const verificationChecks = recipientVerificationChecks(claimedAt);
          const defaultPolicyId = deterministicAgentEmailUlid(
            "1970-01-01T00:00:00.000Z",
            "environment-policy-v1",
            command.organizationId,
            command.projectId,
            command.environmentId,
          );
          const claimed = withCanonicalRecordKeys({
            data: {
              ...currentMessage.data,
              status: "sending" as const,
              updatedAt: claimedAt,
              version: currentMessage.data.version + 1,
            },
            itemType: "inbox-message" as const,
            ...(currentMessage.ttl === undefined ? {} : { ttl: currentMessage.ttl }),
          }) as typeof currentMessage;
          const claimOperations = [
            agentEmailSendPrerequisiteConditionCheck(environmentRecord, "active"),
            agentEmailSendPrerequisiteConditionCheck(inbox, "active"),
            agentEmailSendPrerequisiteConditionCheck(domain, "verified"),
            agentEmailSendPrerequisiteConditionCheck(placement, "active"),
            ...(policy
              ? [policyConditionCheck(policy)]
              : [
                  {
                    conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                    key: {
                      pk: `ORG#${command.organizationId}#ENV#${command.environmentId}`,
                      sk: `INBOX-POLICY#${defaultPolicyId}`,
                    },
                    kind: "condition-check" as const,
                    table: "control" as const,
                  },
                ]),
            ...verificationChecks,
            ...suppressionClaimChecks(message, command),
            { kind: "put" as const, previousRecord: currentMessage, record: claimed },
          ];
          const operationLimitFailure = agentEmailClaimOperationLimitFailure(
            recipientAddresses.length,
            verificationChecks.length,
          );
          if (operationLimitFailure) {
            throw new Error(operationLimitFailure.failureReason);
          }
          await agentEmailPersistence.commit(database, claimOperations);
          currentMessage = claimed;
        },
        command,
        kind: "found",
        message,
        release: async (releasedAt) => {
          const released = withCanonicalRecordKeys({
            data: {
              ...currentMessage.data,
              status: message.scheduledAt ? ("scheduled" as const) : ("queued" as const),
              updatedAt: releasedAt,
              version: currentMessage.data.version + 1,
            },
            itemType: "inbox-message" as const,
            ...(currentMessage.ttl === undefined ? {} : { ttl: currentMessage.ttl }),
          }) as typeof currentMessage;
          await agentEmailPersistence.commit(database, [
            { kind: "put", previousRecord: currentMessage, record: released },
          ]);
          currentMessage = released;
        },
        send: () => aws.outbound.send(message),
        update,
      };
    },
    now: () => new Date(),
  };
}

let runtime: AgentEmailSendMainDependencies | undefined;

export async function handleAgentEmailSendQueue(
  event: AgentEmailSendQueueEvent,
  dependencies = (runtime ??= createAwsAgentEmailSendDependencies()),
) {
  const batchItemFailures: { readonly itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    try {
      await processAgentEmailSend(decodeAgentEmailSendQueueMessage(record.body), dependencies);
    } catch (cause) {
      console.error("Agent email send command failed.", {
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

export const handler = (event: AgentEmailSendQueueEvent) => handleAgentEmailSendQueue(event);
