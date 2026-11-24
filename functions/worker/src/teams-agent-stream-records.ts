import {
  TeamsAgentStreamRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { RunRecordValue } from "./types.ts";

type Binding = Extract<PlatformRecord, { readonly itemType: "channel-binding" }>;
type TeamsStream = Extract<PlatformRecord, { readonly itemType: "teams-agent-stream" }>;

export function startingTeamsAgentStreamRecord(input: {
  readonly binding: Binding;
  readonly conversationId: string;
  readonly recipientId: string;
  readonly run: RunRecordValue;
  readonly serviceUrl: string;
  readonly tenantId: string;
  readonly timestamp: Date;
}) {
  const credentialRef = input.binding.data.credentialRef;
  if (!credentialRef || !("store" in credentialRef) || credentialRef.store !== "dynamodb-kms") {
    throw new Error("Teams channel binding credential reference is unavailable.");
  }
  return Schema.decodeUnknownSync(TeamsAgentStreamRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: input.run.data.agentDeploymentId,
        bindingId: input.binding.data.id,
        bindingVersion: input.binding.data.version,
        conversationId: input.conversationId,
        createdAt: input.timestamp.toISOString(),
        credentialRef,
        environmentId: input.run.data.environmentId,
        fallbackAllowed: false,
        id: input.run.data.id,
        organizationId: input.run.data.organizationId,
        projectId: input.run.data.projectId,
        recipientId: input.recipientId,
        runAttempt: input.run.data.attempt,
        runClaimedAt: input.run.data.claimedAt ?? input.run.data.updatedAt,
        runExecutionVersion: input.run.data.version,
        runId: input.run.data.id,
        serviceUrl: input.serviceUrl,
        status: "starting" as const,
        tenantId: input.tenantId,
        threadId: input.run.data.threadId,
        updatedAt: input.timestamp.toISOString(),
        version: 0,
        ...(input.binding.data.workspaceId ? { workspaceId: input.binding.data.workspaceId } : {}),
      },
      itemType: "teams-agent-stream" as const,
    }),
  );
}

export function nextTeamsAgentStreamRecord(
  previous: TeamsStream,
  patch: Partial<TeamsStream["data"]>,
  timestamp: Date,
) {
  return Schema.decodeUnknownSync(TeamsAgentStreamRecord)(
    withCanonicalRecordKeys({
      data: Object.fromEntries(
        Object.entries({
          ...previous.data,
          ...patch,
          updatedAt: timestamp.toISOString(),
          version: previous.data.version + 1,
        }).filter(([, value]) => value !== undefined),
      ),
      itemType: "teams-agent-stream" as const,
    }),
  );
}
