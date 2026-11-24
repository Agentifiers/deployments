import type { Tag } from "@aws-sdk/client-sesv2";
import type { Tag as SnsTag } from "@aws-sdk/client-sns";
import type { AgentEmailPlacementRecord } from "../../core/index.ts";

export interface AgentEmailRegionalSendingState {
  readonly max24HourSend?: number;
  readonly maxSendRate?: number;
  readonly productionAccessEnabled: boolean;
  readonly region: string;
  readonly sendingEnabled: boolean;
}

export type AgentEmailPlacementProviderOperation =
  | "configuration-set"
  | "dedicated-pool"
  | "delivery-options"
  | "event-destination"
  | "multi-region-endpoint"
  | "shared-pool-cleanup";

export class AgentEmailPlacementProviderError extends Error {
  readonly operation: AgentEmailPlacementProviderOperation;

  constructor(operation: AgentEmailPlacementProviderOperation, cause: unknown) {
    super(`Amazon SES placement ${operation} operation failed.`, { cause });
    this.name = "AgentEmailPlacementProviderError";
    this.operation = operation;
  }
}

export async function runAgentEmailPlacementProviderOperation<Value>(
  operation: AgentEmailPlacementProviderOperation,
  effect: () => Promise<Value>,
) {
  try {
    return await effect();
  } catch (cause) {
    if (cause instanceof AgentEmailPlacementProviderError) throw cause;
    throw new AgentEmailPlacementProviderError(operation, cause);
  }
}

export async function agentEmailDedicatedPoolExists(load: () => Promise<unknown>) {
  try {
    await load();
    return true;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "NotFoundException") return false;
    throw cause;
  }
}

export async function agentEmailDedicatedPoolReadyForDeletion(
  load: () => Promise<unknown>,
  checkOwnership: () => Promise<boolean>,
) {
  if (!(await agentEmailDedicatedPoolExists(load))) return false;
  try {
    return await checkOwnership();
  } catch (cause) {
    if (!(await agentEmailDedicatedPoolExists(load))) return false;
    throw cause;
  }
}

export function agentEmailPlacementProviderNames(placement: Pick<AgentEmailPlacementRecord, "id">) {
  const stableId = placement.id.replaceAll(/[^a-zA-Z0-9_-]/gu, "-").slice(-40);
  return {
    configurationSetName: `agent-inboxes-${stableId}`.slice(0, 64),
    endpointName: `agent-inboxes-${stableId}`.slice(0, 64),
    poolName: `agent-inboxes-${stableId}`.slice(0, 64),
  };
}

export function agentEmailPlacementSendingPoolName(
  placement: Pick<AgentEmailPlacementRecord, "dedicatedPool">,
  dedicatedPoolName: string,
) {
  return placement.dedicatedPool ? dedicatedPoolName : undefined;
}

export function agentEmailPlacementPoolNamesForCleanup(
  placement: Pick<AgentEmailPlacementRecord, "dedicatedPool" | "providerMetadata">,
  deterministicPoolName: string,
) {
  const persistedPoolName = placement.providerMetadata.poolName;
  return [
    ...new Set([
      ...(typeof persistedPoolName === "string" && persistedPoolName.trim()
        ? [persistedPoolName]
        : []),
      ...(placement.dedicatedPool ? [deterministicPoolName] : []),
    ]),
  ];
}

export function agentEmailPlacementConfigurationSetArn(
  partition: string,
  region: string,
  accountId: string,
  configurationSetName: string,
) {
  return `arn:${partition}:ses:${region}:${accountId}:configuration-set/${configurationSetName}`;
}

export function agentEmailPlacementDedicatedPoolArn(
  partition: string,
  region: string,
  accountId: string,
  poolName: string,
) {
  return `arn:${partition}:ses:${region}:${accountId}:dedicated-ip-pool/${poolName}`;
}

export function agentEmailPlacementMultiRegionEndpointArn(
  partition: string,
  region: string,
  accountId: string,
  endpointName: string,
) {
  return `arn:${partition}:ses:${region}:${accountId}:multi-region-endpoint/${endpointName}`;
}

export function assertAgentEmailPlacementResourceOwnership(
  placement: Pick<AgentEmailPlacementRecord, "id" | "organizationId">,
  tags: readonly Tag[],
) {
  const values = new Map(tags.map((tag) => [tag.Key, tag.Value]));
  if (
    values.get("agent-inboxes:organization-id") !== placement.organizationId ||
    values.get("agent-inboxes:resource-id") !== placement.id
  ) {
    throw new Error(`Amazon SES resource is not owned by placement ${placement.id}.`);
  }
}

export function assertAgentEmailPlacementEndpointOwnership(
  placement: Pick<AgentEmailPlacementRecord, "id" | "providerMetadata" | "secondaryRegion">,
  endpoint: {
    readonly EndpointId?: string | undefined;
    readonly EndpointName?: string | undefined;
    readonly Routes?: readonly { readonly Region?: string | undefined }[] | undefined;
  },
) {
  const expectedName = agentEmailPlacementProviderNames(placement).endpointName;
  const expectedEndpointId = placement.providerMetadata.endpointId;
  const routes = endpoint.Routes?.map((route) => route.Region).filter(Boolean) ?? [];
  if (
    !endpoint.EndpointId ||
    endpoint.EndpointName !== expectedName ||
    !placement.secondaryRegion ||
    routes.length !== 1 ||
    routes[0] !== placement.secondaryRegion ||
    (typeof expectedEndpointId === "string" &&
      expectedEndpointId &&
      endpoint.EndpointId !== expectedEndpointId)
  ) {
    throw new Error(`Amazon SES multi-region endpoint is not owned by placement ${placement.id}.`);
  }
}

export function assertAgentEmailRegionalTopicOwnership(
  primaryTopicArn: string,
  tags: readonly SnsTag[],
) {
  const values = new Map(tags.map((tag) => [tag.Key, tag.Value]));
  if (
    values.get("agent-inboxes:managed") !== "true" ||
    values.get("agent-inboxes:primary-topic-arn") !== primaryTopicArn
  ) {
    throw new Error(
      `Amazon SNS topic is not owned by the primary agent email topic ${primaryTopicArn}.`,
    );
  }
}

function validSendingQuota(value: number | undefined) {
  return value === -1 || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

export function agentEmailRegionalSendingError(
  regionalStates: readonly AgentEmailRegionalSendingState[],
  operation: "provisioning" | "reconciliation",
) {
  if (regionalStates.some((state) => !state.sendingEnabled)) {
    return `Amazon SES sending is disabled in one or more placement regions during ${operation}.`;
  }
  if (regionalStates.some((state) => !state.productionAccessEnabled)) {
    return `Amazon SES production access is unavailable in one or more placement regions during ${operation}.`;
  }
  if (
    regionalStates.some(
      (state) => !validSendingQuota(state.max24HourSend) || !validSendingQuota(state.maxSendRate),
    )
  ) {
    return `Amazon SES sending quotas are unavailable in one or more placement regions during ${operation}.`;
  }
  const baseline = regionalStates[0];
  if (
    baseline &&
    regionalStates.some(
      (state) =>
        state.max24HourSend !== baseline.max24HourSend ||
        state.maxSendRate !== baseline.maxSendRate,
    )
  ) {
    return `Amazon SES sending quotas do not match across placement regions during ${operation}.`;
  }
  return undefined;
}

export function agentEmailPlacementStatus(args: {
  readonly endpointStatus?: string;
  readonly hasSecondaryRegion: boolean;
  readonly regionalStates: readonly AgentEmailRegionalSendingState[];
}): AgentEmailPlacementRecord["status"] {
  if (args.endpointStatus === "FAILED") return "failed";
  if (
    args.regionalStates.length === 0 ||
    agentEmailRegionalSendingError(args.regionalStates, "reconciliation")
  ) {
    return "reconciling";
  }
  if (args.hasSecondaryRegion && args.endpointStatus !== "READY") return "reconciling";
  return "active";
}
