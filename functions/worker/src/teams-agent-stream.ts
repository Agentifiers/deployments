import { externalThreadTarget } from "@deployments-ai/channel-adapters";
import {
  allowedTeamsServiceUrl,
  teamsAgentPlanText,
  teamsMarkdownMessageText,
  teamsStreamFinalActivity,
  teamsStreamInformativeActivity,
  teamsTerminalText,
  type TeamsAgentIdentity,
} from "@deployments-ai/channel-adapters/teams";
import { key, makeTeamsAgentStreamPersistence, type PlatformRecord } from "@deployments-ai/db";
import { channelAgentStreamBinding } from "./channel-agent-stream-ingress.ts";
import { channelAgentStreamPlan } from "./channel-agent-stream-plan.ts";
import {
  slackMetadata as metadata,
  slackMetadataText as text,
} from "./slack-agent-stream-metadata.ts";
import {
  teamsAgentStreamAuthorization,
  type TeamsAgentStreamAuthorization,
} from "./teams-agent-stream-authorization.ts";
import {
  TeamsAgentStreamAuthorizationError,
  TeamsAgentStreamInitializationRetryableError,
  TeamsAgentStreamMissingIdError,
  teamsDefinitiveRejection,
  teamsStartSafeToFallback,
} from "./teams-agent-stream-errors.ts";
import {
  persistTeamsTerminalFallback,
  reconcileSuppressedTeamsFallback,
} from "./teams-agent-stream-fallback.ts";
import {
  drainTeamsAgentStreamUpdates,
  teamsStreamWindowElapsed,
  trackTeamsAgentStreamUpdates,
} from "./teams-agent-stream-progress.ts";
import {
  nextTeamsAgentStreamRecord as nextRecord,
  startingTeamsAgentStreamRecord as startingRecord,
} from "./teams-agent-stream-records.ts";
import type { AgentRunWorkerDependencies, MessageRecordValue, RunRecordValue } from "./types.ts";

export { TeamsAgentStreamInitializationRetryableError } from "./teams-agent-stream-errors.ts";
type TeamsStream = Extract<PlatformRecord, { readonly itemType: "teams-agent-stream" }>;
type TerminalStatus = "canceled" | "completed" | "failed";
const COMPENSATED_START_PERSISTENCE_ATTEMPTS = 8;
const WAITING_TEXT = "Waiting for the next step before continuing.";

async function writeRecord(
  dependencies: AgentRunWorkerDependencies,
  record: TeamsStream,
  previous?: TeamsStream,
) {
  return makeTeamsAgentStreamPersistence(dependencies.database).save(record, previous);
}

export async function loadTeamsAgentStream(
  dependencies: AgentRunWorkerDependencies,
  run: { readonly data: { readonly id: string; readonly organizationId: string } },
) {
  const value = await makeTeamsAgentStreamPersistence(dependencies.database).load(
    "execution",
    key("ORG", run.data.organizationId, "RUN", run.data.id),
    key("TEAMS-AGENT-STREAM", run.data.id),
  );
  return value?.itemType === "teams-agent-stream" ? value : undefined;
}

/**
 * The personal-chat route of a Teams ingress message. Teams streams only in 1:1 chats; group
 * chats and channels receive the ordinary post-run delivery.
 */
function personalChatRoute(message: MessageRecordValue) {
  const messageMetadata = metadata(message.data.metadata);
  const providerMetadata = metadata(messageMetadata.providerMetadata);
  if (providerMetadata.teamsConversationType !== "personal") return undefined;
  const tenantId = text(messageMetadata, "externalWorkspaceId");
  const threadKey = text(messageMetadata, "externalThreadKey");
  const recipientId = text(providerMetadata, "teamsFromId");
  const serviceUrlText = text(providerMetadata, "teamsServiceUrl");
  const serviceUrl = serviceUrlText ? allowedTeamsServiceUrl(serviceUrlText) : undefined;
  if (!tenantId || !threadKey || !recipientId || !serviceUrl) return undefined;
  if (!threadKey.startsWith(`teams:${tenantId}:thread:`)) return undefined;
  const conversationId = externalThreadTarget(threadKey);
  return conversationId ? { conversationId, recipientId, serviceUrl, tenantId } : undefined;
}

async function markFailed(
  dependencies: AgentRunWorkerDependencies,
  stream: TeamsStream,
  cause: unknown,
  fallbackAllowed = false,
) {
  const lastError = (cause instanceof Error ? cause.message : "Teams agent stream failed.").slice(
    0,
    1_000,
  );
  let persistenceCause: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = attempt === 0 ? stream : await loadTeamsAgentStream(dependencies, stream);
    if (!current) throw persistenceCause;
    if (current.data.status === "failed") {
      if (
        current.data.fallbackAllowed === fallbackAllowed &&
        current.data.lastError === lastError
      ) {
        await reconcileSuppressedTeamsFallback(dependencies, current);
        return current;
      }
      throw persistenceCause;
    }
    if (current.data.status !== stream.data.status) throw persistenceCause;
    try {
      const failed = await writeRecord(
        dependencies,
        nextRecord(
          current,
          { fallbackAllowed, lastError, status: "failed" },
          dependencies.now?.() ?? new Date(),
        ),
        current,
      );
      await reconcileSuppressedTeamsFallback(dependencies, failed);
      return failed;
    } catch (writeCause) {
      persistenceCause = writeCause;
    }
  }
  throw persistenceCause;
}

async function persistCompensatedStart(
  dependencies: AgentRunWorkerDependencies,
  stream: TeamsStream,
  streamId: string,
  cause: unknown,
  signal?: AbortSignal,
) {
  const lastError = (cause instanceof Error ? cause.message : "Teams agent stream failed.").slice(
    0,
    1_000,
  );
  let persistenceCause: unknown;
  for (let attempt = 0; attempt < COMPENSATED_START_PERSISTENCE_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) break;
    const current = attempt === 0 ? stream : await loadTeamsAgentStream(dependencies, stream);
    if (!current) {
      persistenceCause = new Error("Compensated Teams stream state disappeared.");
    } else {
      if (current.data.status === "failed" && current.data.fallbackAllowed) return current;
      if (
        current.data.status !== "starting" &&
        !(current.data.status === "streaming" && current.data.streamId === streamId)
      ) {
        throw new TeamsAgentStreamInitializationRetryableError(
          new Error("Compensated Teams stream generation changed before reconciliation."),
        );
      }
      try {
        const failed = await writeRecord(
          dependencies,
          nextRecord(
            current,
            { fallbackAllowed: true, lastError, status: "failed" },
            dependencies.now?.() ?? new Date(),
          ),
          current,
        );
        await reconcileSuppressedTeamsFallback(dependencies, failed);
        return failed;
      } catch (writeCause) {
        persistenceCause = writeCause;
      }
    }
    if (attempt < COMPENSATED_START_PERSISTENCE_ATTEMPTS - 1) {
      const backoff = Promise.withResolvers<void>();
      setTimeout(backoff.resolve, Math.min(10 * 2 ** attempt, 100));
      await backoff.promise;
    }
  }
  throw new TeamsAgentStreamInitializationRetryableError(signal?.reason ?? persistenceCause);
}

export async function ensureTeamsAgentStream(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  trigger: MessageRecordValue,
  signal?: AbortSignal,
): Promise<TeamsStream | undefined> {
  // Preview and evaluation runs never publish to channels. Externally published runs do stream:
  // the stopped stream is their provider confirmation for the delivery worker.
  if (run.data.executionBindingId !== undefined) return undefined;
  if (!dependencies.readChannelCredential || !dependencies.teamsAgentStream) return undefined;
  const existing = await loadTeamsAgentStream(dependencies, run);
  if (existing) {
    const newerClaim = (run.data.claimedAt ?? run.data.updatedAt) !== existing.data.runClaimedAt;
    if (existing.data.status === "streaming" && newerClaim) {
      const reconciled = await pauseTeamsAgentStream(dependencies, run);
      if (reconciled?.data.status === "paused") {
        return startTeamsAgentStream(dependencies, run, trigger, signal, reconciled);
      }
      throw new TeamsAgentStreamInitializationRetryableError(
        new Error("A prior Teams stream generation could not be reconciled."),
      );
    }
    if (existing.data.fallbackDeliveryId)
      throw new TeamsAgentStreamInitializationRetryableError(
        new Error("A prior Teams stream generation is still being finalized or delivered."),
      );
    if (
      existing.data.status === "paused" ||
      ((existing.data.status === "stopped" ||
        (existing.data.status === "failed" && existing.data.fallbackAllowed)) &&
        newerClaim)
    ) {
      return startTeamsAgentStream(dependencies, run, trigger, signal, existing);
    }
    if (existing.data.status === "failed" && !existing.data.fallbackAllowed) {
      throw new TeamsAgentStreamInitializationRetryableError(
        new Error(
          "Teams stream start outcome remains ambiguous; automatic restart was suppressed.",
        ),
      );
    }
    if (existing.data.status !== "starting") return existing;
    throw new TeamsAgentStreamInitializationRetryableError(
      new Error("Teams stream start outcome remains unresolved; automatic restart was suppressed."),
    );
  }
  return startTeamsAgentStream(dependencies, run, trigger, signal);
}

async function startTeamsAgentStream(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  message: MessageRecordValue,
  signal?: AbortSignal,
  paused?: TeamsStream,
): Promise<TeamsStream | undefined> {
  const client = dependencies.teamsAgentStream;
  const runDeploymentId = run.data.agentDeploymentId;
  if (!client || runDeploymentId === undefined) return undefined;
  const binding = await channelAgentStreamBinding(
    run,
    message,
    dependencies,
    (candidate) => candidate.channel === "teams" && candidate.provider === "teams_bot_framework",
  );
  if (!binding) return undefined;
  const route = personalChatRoute(message);
  if (!route) return undefined;
  const timestamp = dependencies.now?.() ?? new Date();
  let stream: TeamsStream;
  if (paused) {
    const credentialRef = binding.data.credentialRef;
    if (!credentialRef || !("store" in credentialRef) || credentialRef.store !== "dynamodb-kms") {
      return undefined;
    }
    stream = await writeRecord(
      dependencies,
      nextRecord(
        paused,
        {
          agentDeploymentId: binding.data.agentDeploymentId ?? runDeploymentId,
          bindingId: binding.data.id,
          bindingVersion: binding.data.version,
          conversationId: route.conversationId,
          credentialRef,
          fallbackAllowed: false,
          fallbackDeliveryId: undefined,
          lastError: undefined,
          recipientId: route.recipientId,
          runAttempt: run.data.attempt,
          runClaimedAt: run.data.claimedAt ?? run.data.updatedAt,
          runExecutionVersion: run.data.version,
          serviceUrl: route.serviceUrl,
          status: "starting",
          streamId: undefined,
          streamStartedAt: undefined,
          tenantId: route.tenantId,
        },
        timestamp,
      ),
      paused,
    );
  } else {
    try {
      stream = await writeRecord(
        dependencies,
        startingRecord({ binding, ...route, run, timestamp }),
      );
    } catch (cause) {
      const raced = await loadTeamsAgentStream(dependencies, run);
      if (raced?.data.status === "starting") stream = raced;
      else if (raced) return raced;
      else throw cause;
    }
  }
  let authorization: TeamsAgentStreamAuthorization;
  try {
    authorization = await teamsAgentStreamAuthorization(dependencies, stream);
  } catch (cause) {
    const fallbackAllowed = !(cause instanceof TeamsAgentStreamAuthorizationError);
    return markFailed(dependencies, stream, cause, fallbackAllowed);
  }
  const target = {
    conversationId: stream.data.conversationId,
    credentials: authorization.credentials,
    serviceUrl: stream.data.serviceUrl,
  };
  try {
    const currentPlan = await channelAgentStreamPlan(dependencies, run);
    const planText = currentPlan
      ? teamsAgentPlanText({ eventType: "agent.plan.updated", plan: currentPlan })
      : undefined;
    const result = await client.sendActivity({
      ...target,
      activity: teamsStreamInformativeActivity({
        sequence: 1,
        text: planText ?? (message.data.body ? `Working on: ${message.data.body}` : ""),
      }),
    });
    const streamId = result.id?.trim();
    if (!streamId) throw new TeamsAgentStreamMissingIdError();
    try {
      const startedAt = dependencies.now?.() ?? new Date();
      const streaming = await writeRecord(
        dependencies,
        nextRecord(
          stream,
          { status: "streaming", streamId, streamStartedAt: startedAt.toISOString() },
          startedAt,
        ),
        stream,
      );
      trackTeamsAgentStreamUpdates(dependencies, streaming, { planned: currentPlan !== undefined });
      return streaming;
    } catch (cause) {
      let stopConfirmed = false;
      try {
        await client.sendActivity({
          ...target,
          activity: teamsStreamFinalActivity({
            streamId,
            text: teamsTerminalText({
              body: "",
              error: "Agent progress stream could not be persisted.",
              ...(authorization.identity ? { identity: authorization.identity } : {}),
              status: "failed",
            }),
          }),
        });
        stopConfirmed = true;
      } catch (stopCause) {
        stopConfirmed = teamsDefinitiveRejection(stopCause);
        // The durable starting state prevents an unsafe automatic restart after an ambiguous stop.
      }
      try {
        if (stopConfirmed) {
          return await persistCompensatedStart(dependencies, stream, streamId, cause, signal);
        }
        await markFailed(dependencies, stream, cause, false);
        throw new TeamsAgentStreamInitializationRetryableError(cause);
      } catch (reconciliationCause) {
        if (reconciliationCause instanceof TeamsAgentStreamInitializationRetryableError) {
          throw reconciliationCause;
        }
        throw new TeamsAgentStreamInitializationRetryableError(reconciliationCause);
      }
    }
  } catch (cause) {
    if (cause instanceof TeamsAgentStreamInitializationRetryableError) throw cause;
    const safeToFallback = teamsStartSafeToFallback(cause);
    const failed = await markFailed(dependencies, stream, cause, safeToFallback);
    if (!safeToFallback) throw new TeamsAgentStreamInitializationRetryableError(cause);
    return failed;
  }
}

/** Replaces the stream segment's message with `text` (the `chat.update` analogue). */
async function updateStreamMessage(
  dependencies: AgentRunWorkerDependencies,
  stream: TeamsStream,
  streamId: string,
  text: (identity: TeamsAgentIdentity | undefined) => string,
) {
  const { credentials, identity } = await teamsAgentStreamAuthorization(dependencies, stream);
  await dependencies.teamsAgentStream!.updateActivity({
    activity: {
      text: teamsMarkdownMessageText(text(identity)),
      textFormat: "markdown",
      type: "message",
    },
    activityId: streamId,
    conversationId: stream.data.conversationId,
    credentials,
    serviceUrl: stream.data.serviceUrl,
  });
}

/**
 * Ends a streaming segment with `text`: the final stream message while the stream window is
 * open, otherwise (or when Teams definitively refuses the final message, e.g. because the user
 * stopped the stream) an update of the segment's message.
 */
async function endStreamingSegment(
  dependencies: AgentRunWorkerDependencies,
  stream: TeamsStream,
  streamId: string,
  text: (identity: TeamsAgentIdentity | undefined) => string,
) {
  if (!teamsStreamWindowElapsed(dependencies, stream)) {
    const { credentials, identity } = await teamsAgentStreamAuthorization(dependencies, stream);
    try {
      await dependencies.teamsAgentStream!.sendActivity({
        activity: teamsStreamFinalActivity({ streamId, text: text(identity) }),
        conversationId: stream.data.conversationId,
        credentials,
        serviceUrl: stream.data.serviceUrl,
      });
      return;
    } catch (cause) {
      if (!teamsDefinitiveRejection(cause)) throw cause;
    }
  }
  await updateStreamMessage(dependencies, stream, streamId, text);
}

async function stoppedRecord(dependencies: AgentRunWorkerDependencies, stream: TeamsStream) {
  const stopped = await writeRecord(
    dependencies,
    nextRecord(stream, { status: "stopped" }, dependencies.now?.() ?? new Date()),
    stream,
  );
  await reconcileSuppressedTeamsFallback(dependencies, stopped);
  return stopped;
}

/**
 * Classifies a failed segment mutation: lost authorization fails without fallback, a definitive
 * Teams rejection fails with fallback (queuing the terminal notice of a failed or canceled run),
 * and anything else is ambiguous and surfaces for a retry.
 */
async function failedSegment(
  dependencies: AgentRunWorkerDependencies,
  stream: TeamsStream,
  cause: unknown,
  terminal?: { readonly body: string; readonly run: RunRecordValue },
) {
  if (cause instanceof TeamsAgentStreamAuthorizationError) {
    return markFailed(dependencies, stream, cause, false);
  }
  if (!teamsDefinitiveRejection(cause)) throw cause;
  const failed = await markFailed(dependencies, stream, cause, true);
  if (terminal)
    await persistTeamsTerminalFallback(dependencies, terminal.run, failed, terminal.body);
  return failed;
}

export async function finalizeTeamsAgentStream(input: {
  readonly body?: string;
  readonly dependencies: AgentRunWorkerDependencies;
  readonly run: RunRecordValue;
}) {
  const { dependencies, run } = input;
  await drainTeamsAgentStreamUpdates(dependencies, run.data.id);
  const stream = await loadTeamsAgentStream(dependencies, run);
  if (!stream) return stream;
  if (stream.data.status === "starting") {
    throw new TeamsAgentStreamInitializationRetryableError(
      new Error("Teams stream start outcome remains unresolved during terminal reconciliation."),
    );
  }
  const body = input.body ?? "";
  if (
    stream.data.status === "stopped" ||
    (stream.data.status === "failed" && stream.data.fallbackAllowed)
  ) {
    await reconcileSuppressedTeamsFallback(dependencies, stream);
    await persistTeamsTerminalFallback(dependencies, run, stream, body);
    return stream;
  }
  const streamId = stream.data.streamId;
  if ((stream.data.status !== "paused" && stream.data.status !== "streaming") || !streamId) {
    return stream;
  }
  if (!dependencies.readChannelCredential || !dependencies.teamsAgentStream) return stream;
  const finalText = (identity: TeamsAgentIdentity | undefined) =>
    teamsTerminalText({
      body,
      ...(identity ? { identity } : {}),
      status: run.data.status as TerminalStatus,
    });
  try {
    if (stream.data.status === "paused") {
      await updateStreamMessage(dependencies, stream, streamId, finalText);
    } else {
      await endStreamingSegment(dependencies, stream, streamId, finalText);
    }
    return await stoppedRecord(dependencies, stream);
  } catch (cause) {
    return failedSegment(dependencies, stream, cause, { body, run });
  }
}

export async function pauseTeamsAgentStream(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
) {
  await drainTeamsAgentStreamUpdates(dependencies, run.data.id);
  const stream = await loadTeamsAgentStream(dependencies, run);
  const streamId = stream?.data.streamId;
  if (!stream || stream.data.status !== "streaming" || !streamId) return stream;
  if (!dependencies.readChannelCredential || !dependencies.teamsAgentStream) return stream;
  try {
    await endStreamingSegment(dependencies, stream, streamId, (identity) =>
      teamsMarkdownMessageText(WAITING_TEXT, identity),
    );
    return await writeRecord(
      dependencies,
      nextRecord(
        stream,
        { fallbackAllowed: false, status: "paused" },
        dependencies.now?.() ?? new Date(),
      ),
      stream,
    );
  } catch (cause) {
    return failedSegment(dependencies, stream, cause);
  }
}
