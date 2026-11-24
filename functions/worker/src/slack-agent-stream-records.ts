import {
  SlackAgentStreamRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { RunRecordValue } from "./types.ts";

type Binding = Extract<PlatformRecord, { readonly itemType: "channel-binding" }>;
type SlackStream = Extract<PlatformRecord, { readonly itemType: "slack-agent-stream" }>;

export function startingSlackAgentStreamRecord(input: {
  readonly binding: Binding;
  readonly channelId: string;
  readonly recipientTeamId: string;
  readonly recipientUserId: string;
  readonly run: RunRecordValue;
  readonly threadTs: string;
  readonly timestamp: Date;
}) {
  const credentialRef = input.binding.data.credentialRef;
  if (!credentialRef || !("store" in credentialRef) || credentialRef.store !== "dynamodb-kms") {
    throw new Error("Slack channel binding credential reference is unavailable.");
  }
  return Schema.decodeUnknownSync(SlackAgentStreamRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: input.run.data.agentDeploymentId,
        bindingId: input.binding.data.id,
        bindingVersion: input.binding.data.version,
        channelId: input.channelId,
        createdAt: input.timestamp.toISOString(),
        credentialRef,
        environmentId: input.run.data.environmentId,
        fallbackAllowed: false,
        id: input.run.data.id,
        organizationId: input.run.data.organizationId,
        projectId: input.run.data.projectId,
        recipientTeamId: input.recipientTeamId,
        recipientUserId: input.recipientUserId,
        runAttempt: input.run.data.attempt,
        runClaimedAt: input.run.data.claimedAt ?? input.run.data.updatedAt,
        runExecutionVersion: input.run.data.version,
        runId: input.run.data.id,
        status: "starting" as const,
        threadId: input.run.data.threadId,
        threadTs: input.threadTs,
        updatedAt: input.timestamp.toISOString(),
        version: 0,
        ...(input.binding.data.workspaceId ? { workspaceId: input.binding.data.workspaceId } : {}),
      },
      itemType: "slack-agent-stream" as const,
    }),
  );
}

export function nextSlackAgentStreamRecord(
  previous: SlackStream,
  patch: Partial<SlackStream["data"]>,
  timestamp: Date,
) {
  return Schema.decodeUnknownSync(SlackAgentStreamRecord)(
    withCanonicalRecordKeys({
      data: Object.fromEntries(
        Object.entries({
          ...previous.data,
          ...patch,
          updatedAt: timestamp.toISOString(),
          version: previous.data.version + 1,
        }).filter(([, value]) => value !== undefined),
      ),
      itemType: "slack-agent-stream" as const,
    }),
  );
}
