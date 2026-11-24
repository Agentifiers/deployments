import {
  normalizeTeamsAgentIdentity,
  teamsBotCredentials,
  type TeamsAgentIdentity,
  type TeamsBotCredentials,
} from "@deployments-ai/channel-adapters/teams";
import { key, workerPersistence, type PlatformRecord } from "@deployments-ai/db";
import { TeamsAgentStreamAuthorizationError } from "./teams-agent-stream-errors.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";

type TeamsStream = Extract<PlatformRecord, { readonly itemType: "teams-agent-stream" }>;

export interface TeamsAgentStreamAuthorization {
  readonly credentials: TeamsBotCredentials;
  readonly identity: TeamsAgentIdentity | undefined;
}

async function getControlRecord(dependencies: AgentRunWorkerDependencies, pk: string, sk: string) {
  return workerPersistence.read(dependencies.database, "control", { pk, sk }, true);
}

/**
 * Authorizes one Teams stream API call against the live binding: still active and routed to the
 * stream's tenant and conversation, with the credential generation pinned when the stream started.
 * Returns the bot credentials and the binding's current agent identity.
 */
export async function teamsAgentStreamAuthorization(
  dependencies: AgentRunWorkerDependencies,
  stream: TeamsStream,
): Promise<TeamsAgentStreamAuthorization> {
  const binding = await getControlRecord(
    dependencies,
    key("ORG", stream.data.organizationId, "ENV", stream.data.environmentId),
    key("CHANNEL-BINDING", stream.data.bindingId),
  );
  if (
    !binding ||
    binding.itemType !== "channel-binding" ||
    binding.data.id !== stream.data.bindingId ||
    binding.data.agentDeploymentId !== stream.data.agentDeploymentId ||
    binding.data.organizationId !== stream.data.organizationId ||
    binding.data.projectId !== stream.data.projectId ||
    binding.data.environmentId !== stream.data.environmentId ||
    binding.data.workspaceId !== stream.data.workspaceId ||
    binding.data.externalWorkspaceId !== stream.data.tenantId ||
    (binding.data.externalChannelId !== undefined &&
      binding.data.externalChannelId !== stream.data.conversationId &&
      !stream.data.conversationId.startsWith(`${binding.data.externalChannelId};messageid=`)) ||
    binding.data.channel !== "teams" ||
    binding.data.provider !== "teams_bot_framework" ||
    binding.data.status !== "active" ||
    !binding.data.credentialRef ||
    !("store" in binding.data.credentialRef) ||
    binding.data.credentialRef.store !== "dynamodb-kms" ||
    binding.data.credentialRef.credentialId !== stream.data.credentialRef.credentialId ||
    binding.data.credentialRef.generation !== stream.data.credentialRef.generation
  ) {
    throw new TeamsAgentStreamAuthorizationError(
      "Teams channel binding is no longer active for this stream.",
    );
  }
  if (stream.data.workspaceId) {
    const workspace = await getControlRecord(
      dependencies,
      key("ORG", stream.data.organizationId, "ENV", stream.data.environmentId),
      key("WORKSPACE", stream.data.workspaceId),
    );
    if (
      !workspace ||
      workspace.itemType !== "workspace" ||
      workspace.data.organizationId !== stream.data.organizationId ||
      workspace.data.projectId !== stream.data.projectId ||
      workspace.data.environmentId !== stream.data.environmentId ||
      workspace.data.status !== "active"
    ) {
      throw new TeamsAgentStreamAuthorizationError("Teams stream workspace is no longer active.");
    }
  }
  const values = await dependencies.readChannelCredential!({
    bindingId: stream.data.bindingId,
    environmentId: stream.data.environmentId,
    organizationId: stream.data.organizationId,
    projectId: stream.data.projectId,
    reference: stream.data.credentialRef,
  });
  const credentials = teamsBotCredentials(values);
  let identity: TeamsAgentIdentity | undefined;
  try {
    identity = normalizeTeamsAgentIdentity(binding.data.metadata?.teamsAgentIdentity);
  } catch {
    throw new TeamsAgentStreamAuthorizationError(
      "Teams channel binding has an invalid stream identity.",
    );
  }
  return { credentials, identity };
}
