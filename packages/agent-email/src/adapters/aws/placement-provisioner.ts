import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateDedicatedIpPoolCommand,
  CreateMultiRegionEndpointCommand,
  DeleteConfigurationSetCommand,
  DeleteDedicatedIpPoolCommand,
  DeleteMultiRegionEndpointCommand,
  DeleteTenantResourceAssociationCommand,
  GetAccountCommand,
  GetConfigurationSetCommand,
  GetDedicatedIpPoolCommand,
  GetMultiRegionEndpointCommand,
  ListTagsForResourceCommand,
  PutConfigurationSetDeliveryOptionsCommand,
  PutConfigurationSetSendingOptionsCommand,
  UpdateConfigurationSetEventDestinationCommand,
  type EventDestinationDefinition,
} from "@aws-sdk/client-sesv2";
import {
  CreateTopicCommand,
  ListTagsForResourceCommand as ListSnsTagsForResourceCommand,
  ListSubscriptionsByTopicCommand,
  SetTopicAttributesCommand,
  SNSClient,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import type {
  AgentEmailPlacementProvisioner,
  AgentEmailPlacementRecord,
} from "../../core/index.ts";
import {
  agentEmailDedicatedPoolReadyForDeletion,
  agentEmailPlacementConfigurationSetArn,
  agentEmailPlacementDedicatedPoolArn,
  agentEmailPlacementMultiRegionEndpointArn,
  agentEmailPlacementPoolNamesForCleanup,
  agentEmailPlacementProviderNames,
  agentEmailPlacementSendingPoolName,
  agentEmailPlacementStatus,
  agentEmailRegionalSendingError,
  assertAgentEmailPlacementEndpointOwnership,
  assertAgentEmailPlacementResourceOwnership,
  assertAgentEmailRegionalTopicOwnership,
  runAgentEmailPlacementProviderOperation,
  type AgentEmailRegionalSendingState,
} from "./placement-state.ts";
export * from "./placement-state.ts";
import { alreadyExists, notFound, sesClient } from "./ses-client.ts";
import { agentEmailSesTenantName } from "./tenancy.ts";

const snsClients = new Map<string, SNSClient>();

function snsClient(region: string) {
  const existing = snsClients.get(region);
  if (existing) return existing;
  const created = new SNSClient({ region });
  snsClients.set(region, created);
  return created;
}

async function requireOwnedPlacementResource(
  placement: AgentEmailPlacementRecord,
  resourceArn: string,
  region: string,
  allowMissing = false,
) {
  try {
    const response = await sesClient(region).send(
      new ListTagsForResourceCommand({ ResourceArn: resourceArn }),
    );
    assertAgentEmailPlacementResourceOwnership(placement, response.Tags ?? []);
    return true;
  } catch (cause) {
    if (allowMissing && notFound(cause)) return false;
    throw cause;
  }
}

function placementResourceContext() {
  const topic = primaryEventTopic();
  return { accountId: topic.accountId, partition: topic.partition };
}

function primaryEventTopic() {
  const value = process.env.DEPLOYMENTS_AI_AGENT_EMAIL_EVENT_TOPIC_ARN?.trim();
  if (!value) throw new Error("DEPLOYMENTS_AI_AGENT_EMAIL_EVENT_TOPIC_ARN is required.");
  const match = /^arn:([^:]+):sns:([^:]+):(\d+):(.+)$/u.exec(value);
  if (!match) throw new Error("DEPLOYMENTS_AI_AGENT_EMAIL_EVENT_TOPIC_ARN is invalid.");
  const [, partition, region, accountId, name] = match;
  if (!partition || !region || !accountId || !name) {
    throw new Error("DEPLOYMENTS_AI_AGENT_EMAIL_EVENT_TOPIC_ARN is invalid.");
  }
  return { accountId, arn: value, name, partition, region };
}

function eventQueueArn() {
  const value = process.env.DEPLOYMENTS_AI_AGENT_EMAIL_EVENT_QUEUE_ARN?.trim();
  if (!value) throw new Error("DEPLOYMENTS_AI_AGENT_EMAIL_EVENT_QUEUE_ARN is required.");
  return value;
}

export function agentEmailRegionalEventTopicKmsKeyArn(
  region: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const value = environment.DEPLOYMENTS_AI_AGENT_EMAIL_REGIONAL_KMS_KEY_ARNS?.trim();
  if (!value) {
    throw new Error("DEPLOYMENTS_AI_AGENT_EMAIL_REGIONAL_KMS_KEY_ARNS is required.");
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DEPLOYMENTS_AI_AGENT_EMAIL_REGIONAL_KMS_KEY_ARNS is invalid.");
  }
  const keyArn = (parsed as Record<string, unknown>)[region];
  if (typeof keyArn !== "string" || !keyArn.trim()) {
    throw new Error(`No agent email event-topic KMS key is configured for ${region}.`);
  }
  return keyArn.trim();
}

async function ensureRegionalEventTopic(region: string) {
  const primary = primaryEventTopic();
  if (region === primary.region) return primary.arn;
  const kmsKeyArn = agentEmailRegionalEventTopicKmsKeyArn(region);
  const response = await snsClient(region).send(
    new CreateTopicCommand({
      Attributes: { KmsMasterKeyId: kmsKeyArn },
      Name: primary.name,
      Tags: [
        { Key: "agent-inboxes:managed", Value: "true" },
        { Key: "agent-inboxes:primary-topic-arn", Value: primary.arn },
      ],
    }),
  );
  const topicArn = response.TopicArn;
  if (!topicArn) throw new Error(`Amazon SNS did not return an event topic ARN for ${region}.`);
  const topicTags = await snsClient(region).send(
    new ListSnsTagsForResourceCommand({ ResourceArn: topicArn }),
  );
  assertAgentEmailRegionalTopicOwnership(primary.arn, topicTags.Tags ?? []);
  await snsClient(region).send(
    new SetTopicAttributesCommand({
      AttributeName: "KmsMasterKeyId",
      AttributeValue: kmsKeyArn,
      TopicArn: topicArn,
    }),
  );
  await snsClient(region).send(
    new SetTopicAttributesCommand({
      AttributeName: "Policy",
      AttributeValue: JSON.stringify({
        Statement: [
          {
            Action: "SNS:*",
            Effect: "Allow",
            Principal: { AWS: `arn:${primary.partition}:iam::${primary.accountId}:root` },
            Resource: topicArn,
            Sid: "OwnerAccess",
          },
          {
            Action: "SNS:Publish",
            Condition: { StringEquals: { "AWS:SourceAccount": primary.accountId } },
            Effect: "Allow",
            Principal: { Service: "ses.amazonaws.com" },
            Resource: topicArn,
            Sid: "AllowSesPublish",
          },
        ],
        Version: "2012-10-17",
      }),
      TopicArn: topicArn,
    }),
  );
  const queueArn = eventQueueArn();
  const subscriptions = await snsClient(region).send(
    new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }),
  );
  if (
    !subscriptions.Subscriptions?.some(
      (subscription) => subscription.Protocol === "sqs" && subscription.Endpoint === queueArn,
    )
  ) {
    await snsClient(region).send(
      new SubscribeCommand({
        Endpoint: queueArn,
        Protocol: "sqs",
        ReturnSubscriptionArn: true,
        TopicArn: topicArn,
      }),
    );
  }
  return topicArn;
}

async function ensureConfigurationSet(
  placement: AgentEmailPlacementRecord,
  configurationSetName: string,
  region: string,
) {
  let created = false;
  try {
    await sesClient(region).send(
      new CreateConfigurationSetCommand({
        ConfigurationSetName: configurationSetName,
        ReputationOptions: { ReputationMetricsEnabled: true },
        SendingOptions: { SendingEnabled: true },
        Tags: [
          { Key: "agent-inboxes:organization-id", Value: placement.organizationId },
          { Key: "agent-inboxes:resource-id", Value: placement.id },
        ],
      }),
    );
    created = true;
  } catch (cause) {
    if (!alreadyExists(cause)) throw cause;
  }
  if (!created) {
    const { accountId, partition } = placementResourceContext();
    await requireOwnedPlacementResource(
      placement,
      agentEmailPlacementConfigurationSetArn(partition, region, accountId, configurationSetName),
      region,
    );
    await sesClient(region).send(
      new PutConfigurationSetSendingOptionsCommand({
        ConfigurationSetName: configurationSetName,
        SendingEnabled: true,
      }),
    );
  }
  const configurationSet = await sesClient(region).send(
    new GetConfigurationSetCommand({ ConfigurationSetName: configurationSetName }),
  );
  const account = await sesClient(region).send(new GetAccountCommand({}));
  return {
    ...(typeof account.SendQuota?.Max24HourSend === "number"
      ? { max24HourSend: account.SendQuota.Max24HourSend }
      : {}),
    ...(typeof account.SendQuota?.MaxSendRate === "number"
      ? { maxSendRate: account.SendQuota.MaxSendRate }
      : {}),
    productionAccessEnabled: account.ProductionAccessEnabled === true,
    sendingEnabled:
      configurationSet.SendingOptions?.SendingEnabled === true && account.SendingEnabled === true,
  };
}

async function ensureDedicatedPool(
  placement: AgentEmailPlacementRecord,
  poolName: string,
  region: string,
) {
  let created = false;
  try {
    await sesClient(region).send(
      new CreateDedicatedIpPoolCommand({
        PoolName: poolName,
        ScalingMode: "MANAGED",
        Tags: [
          { Key: "agent-inboxes:organization-id", Value: placement.organizationId },
          { Key: "agent-inboxes:resource-id", Value: placement.id },
        ],
      }),
    );
    created = true;
  } catch (cause) {
    if (!alreadyExists(cause)) throw cause;
  }
  if (!created) {
    const { accountId, partition } = placementResourceContext();
    await requireOwnedPlacementResource(
      placement,
      agentEmailPlacementDedicatedPoolArn(partition, region, accountId, poolName),
      region,
    );
  }
}

async function deleteDedicatedPool(
  placement: AgentEmailPlacementRecord,
  poolName: string,
  region: string,
) {
  const { accountId, partition } = placementResourceContext();
  const load = () => sesClient(region).send(new GetDedicatedIpPoolCommand({ PoolName: poolName }));
  if (
    !(await agentEmailDedicatedPoolReadyForDeletion(load, () =>
      requireOwnedPlacementResource(
        placement,
        agentEmailPlacementDedicatedPoolArn(partition, region, accountId, poolName),
        region,
        true,
      ),
    ))
  ) {
    return;
  }
  try {
    await sesClient(region).send(new DeleteDedicatedIpPoolCommand({ PoolName: poolName }));
  } catch (cause) {
    if (!notFound(cause)) throw cause;
  }
}

async function ensureEventDestination(
  placement: AgentEmailPlacementRecord,
  configurationSetName: string,
  region: string,
) {
  const topicArn = await ensureRegionalEventTopic(region);
  const eventDestination: EventDestinationDefinition = {
    Enabled: true,
    MatchingEventTypes: [
      "SEND",
      "REJECT",
      "BOUNCE",
      "COMPLAINT",
      "DELIVERY",
      "RENDERING_FAILURE",
      "DELIVERY_DELAY",
    ],
    SnsDestination: { TopicArn: topicArn },
  };
  try {
    await sesClient(region).send(
      new CreateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: configurationSetName,
        EventDestination: eventDestination,
        EventDestinationName: "agent-email-events",
      }),
    );
  } catch (cause) {
    if (!alreadyExists(cause)) throw cause;
    await sesClient(region).send(
      new UpdateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: configurationSetName,
        EventDestination: eventDestination,
        EventDestinationName: "agent-email-events",
      }),
    );
  }
}

async function ensureRegionalPlacement(
  placement: AgentEmailPlacementRecord,
  names: ReturnType<typeof agentEmailPlacementProviderNames>,
  region: string,
) {
  const sendingState = await runAgentEmailPlacementProviderOperation("configuration-set", () =>
    ensureConfigurationSet(placement, names.configurationSetName, region),
  );
  await runAgentEmailPlacementProviderOperation("event-destination", () =>
    ensureEventDestination(placement, names.configurationSetName, region),
  );
  if (placement.dedicatedPool) {
    await runAgentEmailPlacementProviderOperation("dedicated-pool", () =>
      ensureDedicatedPool(placement, names.poolName, region),
    );
  }
  await runAgentEmailPlacementProviderOperation("delivery-options", () =>
    sesClient(region).send(
      new PutConfigurationSetDeliveryOptionsCommand({
        ConfigurationSetName: names.configurationSetName,
        SendingPoolName: agentEmailPlacementSendingPoolName(placement, names.poolName),
        TlsPolicy: "REQUIRE",
      }),
    ),
  );
  if (!placement.dedicatedPool) {
    await runAgentEmailPlacementProviderOperation("shared-pool-cleanup", () =>
      Promise.all(
        agentEmailPlacementPoolNamesForCleanup(placement, names.poolName).map((poolName) =>
          deleteDedicatedPool(placement, poolName, region),
        ),
      ),
    );
  }
  return { region, ...sendingState } satisfies AgentEmailRegionalSendingState;
}

async function ensureMultiRegionEndpoint(
  placement: AgentEmailPlacementRecord,
  endpointName: string,
) {
  if (!placement.secondaryRegion) return undefined;
  try {
    return await sesClient(placement.region).send(
      new CreateMultiRegionEndpointCommand({
        Details: { RoutesDetails: [{ Region: placement.secondaryRegion }] },
        EndpointName: endpointName,
        Tags: [
          { Key: "agent-inboxes:organization-id", Value: placement.organizationId },
          { Key: "agent-inboxes:resource-id", Value: placement.id },
        ],
      }),
    );
  } catch (cause) {
    if (!alreadyExists(cause)) throw cause;
  }
  const endpoint = await sesClient(placement.region).send(
    new GetMultiRegionEndpointCommand({ EndpointName: endpointName }),
  );
  const context = placementResourceContext();
  await requireOwnedPlacementResource(
    placement,
    agentEmailPlacementMultiRegionEndpointArn(
      context.partition,
      placement.region,
      context.accountId,
      endpointName,
    ),
    placement.region,
  );
  assertAgentEmailPlacementEndpointOwnership(placement, endpoint);
  return endpoint;
}

async function provision(placement: AgentEmailPlacementRecord) {
  const names = agentEmailPlacementProviderNames(placement);
  const regionalStates = await Promise.all([
    ensureRegionalPlacement(placement, names, placement.region),
    ...(placement.secondaryRegion
      ? [ensureRegionalPlacement(placement, names, placement.secondaryRegion)]
      : []),
  ]);
  const endpoint = await runAgentEmailPlacementProviderOperation("multi-region-endpoint", () =>
    ensureMultiRegionEndpoint(placement, names.endpointName),
  );
  const now = new Date().toISOString();
  const sendingError = agentEmailRegionalSendingError(regionalStates, "provisioning");
  const {
    estimatedMonthlyCostCents: _estimatedMonthlyCostCents,
    reconciliationError: _reconciliationError,
    ...placementWithoutError
  } = placement;
  return {
    ...placementWithoutError,
    providerMetadata: {
      configurationSetName: names.configurationSetName,
      ...(endpoint?.EndpointId ? { endpointId: endpoint.EndpointId } : {}),
      ...(placement.secondaryRegion
        ? { endpointName: names.endpointName, endpointStatus: endpoint?.Status ?? "CREATING" }
        : {}),
      ...(placement.dedicatedPool ? { poolName: names.poolName } : {}),
      regionalStates,
    },
    ...(placement.dedicatedPool
      ? (() => {
          const configured = Number(
            process.env.DEPLOYMENTS_AI_AGENT_EMAIL_MANAGED_POOL_MONTHLY_COST_CENTS,
          );
          return Number.isInteger(configured) && configured >= 0
            ? {
                estimatedMonthlyCostCents: configured * (placement.secondaryRegion ? 2 : 1),
              }
            : {};
        })()
      : {}),
    lastReconciledAt: now,
    ...(endpoint?.Status === "FAILED"
      ? { reconciliationError: "Amazon SES multi-region endpoint provisioning failed." }
      : sendingError
        ? { reconciliationError: sendingError }
        : {}),
    status: agentEmailPlacementStatus({
      ...(endpoint?.Status ? { endpointStatus: endpoint.Status } : {}),
      hasSecondaryRegion: Boolean(placement.secondaryRegion),
      regionalStates,
    }),
    updatedAt: now,
  };
}

async function reconcile(placement: AgentEmailPlacementRecord) {
  const names = agentEmailPlacementProviderNames(placement);
  const regions = [
    placement.region,
    ...(placement.secondaryRegion ? [placement.secondaryRegion] : []),
  ];
  const regionalStates = await Promise.all(
    regions.map((region) => ensureRegionalPlacement(placement, names, region)),
  );
  const endpoint = await runAgentEmailPlacementProviderOperation("multi-region-endpoint", () =>
    ensureMultiRegionEndpoint(placement, names.endpointName),
  );
  const now = new Date().toISOString();
  const sendingError = agentEmailRegionalSendingError(regionalStates, "reconciliation");
  const {
    estimatedMonthlyCostCents: _estimatedMonthlyCostCents,
    reconciliationError: _reconciliationError,
    ...placementWithoutError
  } = placement;
  const { poolName: _poolName, ...providerMetadata } = placement.providerMetadata;
  return {
    ...placementWithoutError,
    lastReconciledAt: now,
    providerMetadata: {
      ...providerMetadata,
      configurationSetName: names.configurationSetName,
      ...(endpoint?.EndpointId ? { endpointId: endpoint.EndpointId } : {}),
      ...(placement.secondaryRegion
        ? { endpointName: names.endpointName, endpointStatus: endpoint?.Status }
        : {}),
      ...(placement.dedicatedPool ? { poolName: names.poolName } : {}),
      regionalStates,
    },
    ...(placement.dedicatedPool
      ? (() => {
          const configured = Number(
            process.env.DEPLOYMENTS_AI_AGENT_EMAIL_MANAGED_POOL_MONTHLY_COST_CENTS,
          );
          return Number.isInteger(configured) && configured >= 0
            ? {
                estimatedMonthlyCostCents: configured * (placement.secondaryRegion ? 2 : 1),
              }
            : {};
        })()
      : {}),
    ...(endpoint?.Status === "FAILED"
      ? { reconciliationError: "Amazon SES multi-region endpoint reconciliation failed." }
      : sendingError
        ? { reconciliationError: sendingError }
        : {}),
    status: agentEmailPlacementStatus({
      ...(endpoint?.Status ? { endpointStatus: endpoint.Status } : {}),
      hasSecondaryRegion: Boolean(placement.secondaryRegion),
      regionalStates,
    }),
    updatedAt: now,
  };
}

async function deprovision(placement: AgentEmailPlacementRecord) {
  const names = agentEmailPlacementProviderNames(placement);
  const regions = [
    placement.region,
    ...(placement.secondaryRegion ? [placement.secondaryRegion] : []),
  ];
  const topic = primaryEventTopic();
  const ownedConfigurationSetRegions: string[] = [];
  for (const region of regions) {
    const owned = await requireOwnedPlacementResource(
      placement,
      agentEmailPlacementConfigurationSetArn(
        topic.partition,
        region,
        topic.accountId,
        names.configurationSetName,
      ),
      region,
      true,
    );
    if (!owned) continue;
    ownedConfigurationSetRegions.push(region);
    try {
      // eslint-disable-next-line no-await-in-loop -- All tenant associations are removed before provider deletion starts.
      await sesClient(region).send(
        new DeleteTenantResourceAssociationCommand({
          ResourceArn: agentEmailPlacementConfigurationSetArn(
            topic.partition,
            region,
            topic.accountId,
            names.configurationSetName,
          ),
          TenantName: agentEmailSesTenantName(placement.organizationId),
        }),
      );
    } catch (cause) {
      if (!notFound(cause)) throw cause;
    }
  }
  if (placement.secondaryRegion) {
    try {
      const endpoint = await sesClient(placement.region).send(
        new GetMultiRegionEndpointCommand({ EndpointName: names.endpointName }),
      );
      await requireOwnedPlacementResource(
        placement,
        agentEmailPlacementMultiRegionEndpointArn(
          topic.partition,
          placement.region,
          topic.accountId,
          names.endpointName,
        ),
        placement.region,
      );
      assertAgentEmailPlacementEndpointOwnership(placement, endpoint);
      await sesClient(placement.region).send(
        new DeleteMultiRegionEndpointCommand({ EndpointName: names.endpointName }),
      );
    } catch (cause) {
      if (!notFound(cause)) throw cause;
    }
  }
  for (const region of regions) {
    if (ownedConfigurationSetRegions.includes(region)) {
      try {
        await sesClient(region).send(
          new DeleteConfigurationSetCommand({ ConfigurationSetName: names.configurationSetName }),
        );
      } catch (cause) {
        if (!notFound(cause)) throw cause;
      }
    }
    await Promise.all(
      agentEmailPlacementPoolNamesForCleanup(placement, names.poolName).map((poolName) =>
        deleteDedicatedPool(placement, poolName, region),
      ),
    );
  }
  const now = new Date().toISOString();
  const {
    estimatedMonthlyCostCents: _estimatedMonthlyCostCents,
    reconciliationError: _reconciliationError,
    ...placementWithoutProviderState
  } = placement;
  return {
    ...placementWithoutProviderState,
    lastReconciledAt: now,
    providerMetadata: {},
    status: "disabled" as const,
    updatedAt: now,
  };
}

function prepareReservation(placement: AgentEmailPlacementRecord) {
  if (!placement.dedicatedPool) return placement;
  const names = agentEmailPlacementProviderNames(placement);
  return {
    ...placement,
    providerMetadata: { ...placement.providerMetadata, poolName: names.poolName },
  };
}

export const productionAgentEmailPlacementProvisioner: AgentEmailPlacementProvisioner = {
  deprovision,
  prepareReservation,
  provision,
  reconcile,
};
