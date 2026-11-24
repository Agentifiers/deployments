import { Ulid, key, workerPersistence, type PlatformRecord } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  slackMetadata as metadata,
  slackMetadataText as text,
} from "./slack-agent-stream-metadata.ts";
import type { AgentRunWorkerDependencies, MessageRecordValue, RunRecordValue } from "./types.ts";

export type ChannelAgentStreamBinding = Extract<
  PlatformRecord,
  { readonly itemType: "channel-binding" }
>;

async function readRecord(
  dependencies: AgentRunWorkerDependencies,
  table: "control" | "execution",
  pk: string,
  sk: string,
) {
  return workerPersistence.read(dependencies.database, table, { pk, sk }, true);
}

/**
 * Resolves the active channel binding that delivered a channel-ingress message, scoped to the run
 * and pinned to a DynamoDB-KMS credential, plus its active workspace when the binding has one.
 * `accepts` narrows the binding to one channel provider family.
 */
export async function channelAgentStreamBinding(
  run: RunRecordValue,
  message: MessageRecordValue,
  dependencies: AgentRunWorkerDependencies,
  accepts: (binding: ChannelAgentStreamBinding["data"]) => boolean,
): Promise<ChannelAgentStreamBinding | undefined> {
  const messageMetadata = metadata(message.data.metadata);
  if (messageMetadata.source !== "channel-ingress") return undefined;
  const bindingId = text(messageMetadata, "bindingId");
  if (!bindingId) return undefined;
  let canonicalBindingId: Ulid;
  try {
    canonicalBindingId = Schema.decodeUnknownSync(Ulid)(bindingId);
  } catch {
    return undefined;
  }
  const value = await readRecord(
    dependencies,
    "control",
    key("ORG", run.data.organizationId, "ENV", run.data.environmentId),
    key("CHANNEL-BINDING", canonicalBindingId),
  );
  if (
    !value ||
    value.itemType !== "channel-binding" ||
    value.data.id !== canonicalBindingId ||
    value.data.organizationId !== run.data.organizationId ||
    value.data.projectId !== run.data.projectId ||
    value.data.environmentId !== run.data.environmentId ||
    value.data.agentDeploymentId !== run.data.agentDeploymentId ||
    (value.data.workspaceId !== undefined && value.data.workspaceId !== run.data.workspaceId) ||
    !accepts(value.data) ||
    value.data.status !== "active" ||
    !value.data.credentialRef ||
    !("store" in value.data.credentialRef) ||
    value.data.credentialRef.store !== "dynamodb-kms"
  ) {
    return undefined;
  }
  if (value.data.workspaceId) {
    const workspace = await readRecord(
      dependencies,
      "control",
      key("ORG", run.data.organizationId, "ENV", run.data.environmentId),
      key("WORKSPACE", value.data.workspaceId),
    );
    if (
      !workspace ||
      workspace.itemType !== "workspace" ||
      workspace.data.status !== "active" ||
      workspace.data.organizationId !== run.data.organizationId ||
      workspace.data.projectId !== run.data.projectId ||
      workspace.data.environmentId !== run.data.environmentId
    ) {
      return undefined;
    }
  }
  return value;
}
