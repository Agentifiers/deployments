import { normalizeSlackStreamIdentity } from "@deployments-ai/channel-adapters/slack";
import { key, workerPersistence, type PlatformRecord } from "@deployments-ai/db";
import { SlackAgentStreamAuthorizationError } from "./slack-agent-stream-errors.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";

type SlackStream = Extract<PlatformRecord, { readonly itemType: "slack-agent-stream" }>;

async function getControlRecord(dependencies: AgentRunWorkerDependencies, pk: string, sk: string) {
  return await workerPersistence.read(dependencies.database, "control", { pk, sk }, true);
}

export async function slackAgentStreamAuthorization(
  dependencies: AgentRunWorkerDependencies,
  stream: SlackStream,
) {
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
    binding.data.externalWorkspaceId !== stream.data.recipientTeamId ||
    (binding.data.externalChannelId !== undefined &&
      binding.data.externalChannelId !== stream.data.channelId) ||
    binding.data.channel !== "slack" ||
    (binding.data.provider !== "slack_edge" && binding.data.provider !== "slack_cloudflare_edge") ||
    binding.data.status !== "active" ||
    !binding.data.credentialRef ||
    !("store" in binding.data.credentialRef) ||
    binding.data.credentialRef.store !== "dynamodb-kms" ||
    binding.data.credentialRef.credentialId !== stream.data.credentialRef.credentialId ||
    binding.data.credentialRef.generation !== stream.data.credentialRef.generation
  ) {
    throw new SlackAgentStreamAuthorizationError(
      "Slack channel binding is no longer active for this stream.",
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
      throw new SlackAgentStreamAuthorizationError("Slack stream workspace is no longer active.");
    }
  }
  const values = await dependencies.readChannelCredential!({
    bindingId: stream.data.bindingId,
    environmentId: stream.data.environmentId,
    organizationId: stream.data.organizationId,
    projectId: stream.data.projectId,
    reference: stream.data.credentialRef,
  });
  const token = values.accessToken ?? values.botToken;
  if (!token?.trim()) throw new Error("Slack channel credential is missing accessToken.");
  let identity;
  try {
    identity = normalizeSlackStreamIdentity(binding.data.metadata?.slackAgentIdentity);
  } catch {
    throw new SlackAgentStreamAuthorizationError(
      "Slack channel binding has an invalid stream identity.",
    );
  }
  return { identity, token: token.trim() } as const;
}

export async function slackAgentStreamToken(
  dependencies: AgentRunWorkerDependencies,
  stream: SlackStream,
) {
  return (await slackAgentStreamAuthorization(dependencies, stream)).token;
}
