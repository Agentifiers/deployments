import { key, makeSlackAgentStreamPersistence, type PlatformRecord } from "@deployments-ai/db";
import {
  MAX_SLACK_MARKDOWN_TEXT_CHARACTERS,
  slackStreamMarkdownText,
  slackStreamStartPayload,
  slackTerminalChunks,
  type SlackStreamChunk,
} from "@deployments-ai/channel-adapters/slack";
import type { AgentRunWorkerDependencies, MessageRecordValue, RunRecordValue } from "./types.ts";
import { channelAgentStreamBinding } from "./channel-agent-stream-ingress.ts";
import {
  slackAgentStreamAuthorization,
  slackAgentStreamToken,
} from "./slack-agent-stream-authorization.ts";
import { SlackAgentStreamApiError } from "./slack-agent-stream-client.ts";
import {
  SlackAgentStreamAuthorizationError,
  SlackAgentStreamInitializationRetryableError,
} from "./slack-agent-stream-errors.ts";
import {
  nextSlackAgentStreamRecord as nextRecord,
  startingSlackAgentStreamRecord as startingRecord,
} from "./slack-agent-stream-records.ts";
import { channelAgentStreamPlan } from "./channel-agent-stream-plan.ts";
import { drainSlackAgentProgressBudget } from "./slack-agent-progress-budget.ts";
import {
  persistTerminalFallback,
  reconcileSuppressedFallback,
} from "./slack-agent-stream-fallback.ts";
import {
  slackMetadata as metadata,
  slackMetadataText as text,
} from "./slack-agent-stream-metadata.ts";

export { SlackAgentStreamInitializationRetryableError } from "./slack-agent-stream-errors.ts";
export { SlackAgentStreamApiError, slackAgentStreamClient } from "./slack-agent-stream-client.ts";
export type { SlackAgentStreamClient } from "./slack-agent-stream-client.ts";

type SlackStream = Extract<PlatformRecord, { readonly itemType: "slack-agent-stream" }>;
const COMPENSATED_START_PERSISTENCE_ATTEMPTS = 8;

const getRecord = (
  dependencies: AgentRunWorkerDependencies,
  table: "control" | "execution",
  pk: string,
  sk: string,
) => makeSlackAgentStreamPersistence(dependencies.database).load(table, pk, sk);

async function writeRecord(
  dependencies: AgentRunWorkerDependencies,
  record: SlackStream,
  previous?: SlackStream,
) {
  return makeSlackAgentStreamPersistence(dependencies.database).save(record, previous);
}

export async function loadSlackAgentStream(
  dependencies: AgentRunWorkerDependencies,
  run: { readonly data: { readonly id: string; readonly organizationId: string } },
) {
  const value = await getRecord(
    dependencies,
    "execution",
    key("ORG", run.data.organizationId, "RUN", run.data.id),
    key("SLACK-AGENT-STREAM", run.data.id),
  );
  return value?.itemType === "slack-agent-stream" ? value : undefined;
}

async function markFailed(
  dependencies: AgentRunWorkerDependencies,
  stream: SlackStream,
  cause: unknown,
  fallbackAllowed = false,
) {
  const lastError = (cause instanceof Error ? cause.message : "Slack agent stream failed.").slice(
    0,
    1_000,
  );
  let persistenceCause: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = attempt === 0 ? stream : await loadSlackAgentStream(dependencies, stream);
    if (!current) throw persistenceCause;
    if (current.data.status === "failed") {
      if (
        current.data.fallbackAllowed === fallbackAllowed &&
        current.data.lastError === lastError
      ) {
        await reconcileSuppressedFallback(dependencies, current);
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
      await reconcileSuppressedFallback(dependencies, failed);
      return failed;
    } catch (writeCause) {
      persistenceCause = writeCause;
    }
  }
  throw persistenceCause;
}

/**
 * Slack builds a finished plan-mode stream's message text, which notifications, previews, and
 * search show, as the plan title followed by the answer, so every reply would read "Complete the
 * request …". Once the answer is delivered, rewrite the message as the answer alone; the plan was
 * progress, and dropping it is what clears the text. Best effort: the stream already delivered the
 * answer, so a failed rewrite leaves it as is. An answer over Slack's 12,000-character
 * `markdown_text` limit keeps its streamed message rather than lose text.
 */
async function replaceProgressWithAnswer(
  dependencies: AgentRunWorkerDependencies,
  stream: SlackStream,
  chunks: readonly SlackStreamChunk[],
) {
  const answer = slackStreamMarkdownText(chunks);
  if (
    !answer ||
    chunks.some((chunk) => chunk.type !== "markdown_text") ||
    Array.from(answer).length > MAX_SLACK_MARKDOWN_TEXT_CHARACTERS ||
    !stream.data.streamTs ||
    !dependencies.slackAgentStream
  )
    return;
  try {
    await dependencies.slackAgentStream.update(await slackAgentStreamToken(dependencies, stream), {
      channel: stream.data.channelId,
      markdown_text: answer,
      ts: stream.data.streamTs,
    });
  } catch {
    return;
  }
}

async function persistCompensatedStart(
  dependencies: AgentRunWorkerDependencies,
  stream: SlackStream,
  streamTs: string,
  cause: unknown,
  signal?: AbortSignal,
) {
  const lastError = (cause instanceof Error ? cause.message : "Slack agent stream failed.").slice(
    0,
    1_000,
  );
  let persistenceCause: unknown;
  for (let attempt = 0; attempt < COMPENSATED_START_PERSISTENCE_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) break;
    const current = attempt === 0 ? stream : await loadSlackAgentStream(dependencies, stream);
    if (!current) {
      persistenceCause = new Error("Compensated Slack stream state disappeared.");
    } else {
      if (current.data.status === "failed" && current.data.fallbackAllowed) return current;
      if (
        current.data.status !== "starting" &&
        !(current.data.status === "streaming" && current.data.streamTs === streamTs)
      ) {
        throw new SlackAgentStreamInitializationRetryableError(
          new Error("Compensated Slack stream generation changed before reconciliation."),
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
        await reconcileSuppressedFallback(dependencies, failed);
        return failed;
      } catch (writeCause) {
        persistenceCause = writeCause;
      }
    }
    if (attempt < COMPENSATED_START_PERSISTENCE_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** attempt, 100)));
    }
  }
  throw new SlackAgentStreamInitializationRetryableError(signal?.reason ?? persistenceCause);
}

export async function ensureSlackAgentStream(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  trigger: MessageRecordValue,
  signal?: AbortSignal,
): Promise<SlackStream | undefined> {
  // Preview and evaluation runs never publish to channels. Externally published runs do stream:
  // the stopped stream is their provider confirmation, and the delivery worker publishes the
  // provisional assistant message only after it observes that confirmation.
  if (run.data.executionBindingId !== undefined) return undefined;
  if (!dependencies.readChannelCredential || !dependencies.slackAgentStream) return undefined;
  const existing = await loadSlackAgentStream(dependencies, run);
  if (existing) {
    const newerClaim = (run.data.claimedAt ?? run.data.updatedAt) !== existing.data.runClaimedAt;
    if (existing.data.status === "streaming" && newerClaim) {
      const reconciled = await pauseSlackAgentStream(dependencies, run);
      if (reconciled?.data.status === "paused") {
        return startSlackAgentStream(dependencies, run, trigger, signal, reconciled);
      }
      throw new SlackAgentStreamInitializationRetryableError(
        new Error("A prior Slack stream generation could not be reconciled."),
      );
    }
    if (existing.data.fallbackDeliveryId)
      throw new SlackAgentStreamInitializationRetryableError(
        new Error("A prior Slack stream generation is still being finalized or delivered."),
      );
    if (
      existing.data.status === "paused" ||
      ((existing.data.status === "stopped" ||
        (existing.data.status === "failed" && existing.data.fallbackAllowed)) &&
        newerClaim)
    ) {
      return startSlackAgentStream(dependencies, run, trigger, signal, existing);
    }
    if (existing.data.status === "failed" && !existing.data.fallbackAllowed) {
      throw new SlackAgentStreamInitializationRetryableError(
        new Error(
          "Slack stream start outcome remains ambiguous; automatic restart was suppressed.",
        ),
      );
    }
    if (existing.data.status !== "starting") return existing;
    throw new SlackAgentStreamInitializationRetryableError(
      new Error("Slack stream start outcome remains unresolved; automatic restart was suppressed."),
    );
  }
  return startSlackAgentStream(dependencies, run, trigger, signal);
}

async function startSlackAgentStream(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  message: MessageRecordValue,
  signal?: AbortSignal,
  paused?: SlackStream,
): Promise<SlackStream | undefined> {
  const client = dependencies.slackAgentStream;
  const runDeploymentId = run.data.agentDeploymentId;
  if (!client || runDeploymentId === undefined) return undefined;
  const binding = await channelAgentStreamBinding(
    run,
    message,
    dependencies,
    (candidate) =>
      candidate.channel === "slack" &&
      (candidate.provider === "slack_edge" || candidate.provider === "slack_cloudflare_edge"),
  );
  if (!binding) return undefined;
  const messageMetadata = metadata(message.data.metadata);
  const providerMetadata = metadata(messageMetadata.providerMetadata);
  const channelId = text(messageMetadata, "externalChannelId");
  const recipientTeamId = text(messageMetadata, "externalWorkspaceId");
  const recipientUserId = text(metadata(messageMetadata.sender), "id");
  const threadTs = text(providerMetadata, "messageTs");
  if (!channelId || !recipientTeamId || !recipientUserId || !threadTs) return undefined;
  const externalThreadKey = text(messageMetadata, "externalThreadKey");
  if (externalThreadKey?.includes(":shared:thread:")) return undefined;
  const timestamp = dependencies.now?.() ?? new Date();
  let stream: SlackStream;
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
          channelId,
          credentialRef,
          fallbackAllowed: false,
          fallbackDeliveryId: undefined,
          lastError: undefined,
          recipientTeamId,
          recipientUserId,
          runAttempt: run.data.attempt,
          runClaimedAt: run.data.claimedAt ?? run.data.updatedAt,
          runExecutionVersion: run.data.version,
          status: "starting",
          streamTs: undefined,
        },
        timestamp,
      ),
      paused,
    );
  } else {
    try {
      stream = await writeRecord(
        dependencies,
        startingRecord({
          binding,
          channelId,
          recipientTeamId,
          recipientUserId,
          run,
          threadTs,
          timestamp,
        }),
      );
    } catch (cause) {
      const raced = await loadSlackAgentStream(dependencies, run);
      if (raced?.data.status === "starting") stream = raced;
      else if (raced) return raced;
      else throw cause;
    }
  }
  let authorization: Awaited<ReturnType<typeof slackAgentStreamAuthorization>>;
  try {
    authorization = await slackAgentStreamAuthorization(dependencies, stream);
  } catch (cause) {
    const fallbackAllowed = !(cause instanceof SlackAgentStreamAuthorizationError);
    return markFailed(dependencies, stream, cause, fallbackAllowed);
  }
  try {
    const currentPlan = await channelAgentStreamPlan(dependencies, run);
    const result = await client.start(
      authorization.token,
      slackStreamStartPayload({
        channel: channelId,
        ...(authorization.identity ? { identity: authorization.identity } : {}),
        ...(currentPlan ? { plan: currentPlan } : {}),
        ...(message.data.body ? { planTitle: `Working on: ${message.data.body}` } : {}),
        recipientTeamId,
        recipientUserId,
        threadTs,
      }),
    );
    try {
      return await writeRecord(
        dependencies,
        nextRecord(
          stream,
          { status: "streaming", streamTs: result.ts },
          dependencies.now?.() ?? new Date(),
        ),
        stream,
      );
    } catch (cause) {
      let stopConfirmed = false;
      try {
        await client.stop(authorization.token, {
          channel: stream.data.channelId,
          chunks: slackTerminalChunks({
            body: "",
            error: "Agent progress stream could not be persisted.",
            status: "failed",
          }),
          ts: result.ts,
        });
        stopConfirmed = true;
      } catch (stopCause) {
        stopConfirmed = stopCause instanceof SlackAgentStreamApiError && stopCause.safeToFallback;
        // The durable starting state prevents an unsafe automatic restart after an ambiguous stop.
      }
      try {
        if (stopConfirmed) {
          return await persistCompensatedStart(dependencies, stream, result.ts, cause, signal);
        }
        await markFailed(dependencies, stream, cause, false);
        throw new SlackAgentStreamInitializationRetryableError(cause);
      } catch (reconciliationCause) {
        if (reconciliationCause instanceof SlackAgentStreamInitializationRetryableError) {
          throw reconciliationCause;
        }
        throw new SlackAgentStreamInitializationRetryableError(reconciliationCause);
      }
    }
  } catch (cause) {
    if (cause instanceof SlackAgentStreamInitializationRetryableError) throw cause;
    const safeToFallback = cause instanceof SlackAgentStreamApiError && cause.safeToFallback;
    const failed = await markFailed(dependencies, stream, cause, safeToFallback);
    if (!safeToFallback) throw new SlackAgentStreamInitializationRetryableError(cause);
    return failed;
  }
}

export async function finalizeSlackAgentStream(input: {
  readonly body?: string;
  readonly dependencies: AgentRunWorkerDependencies;
  readonly run: RunRecordValue;
}) {
  await drainSlackAgentProgressBudget(input.dependencies, input.run.data.id);
  const stream = await loadSlackAgentStream(input.dependencies, input.run);
  if (!stream) return stream;
  if (stream.data.status === "starting") {
    throw new SlackAgentStreamInitializationRetryableError(
      new Error("Slack stream start outcome remains unresolved during terminal reconciliation."),
    );
  }
  if (
    stream.data.status === "stopped" ||
    (stream.data.status === "failed" && stream.data.fallbackAllowed)
  ) {
    await reconcileSuppressedFallback(input.dependencies, stream);
    await persistTerminalFallback(
      input.dependencies,
      input.run,
      stream,
      slackTerminalChunks({
        body: input.body ?? "",
        status: input.run.data.status as "canceled" | "completed" | "failed",
      }),
    );
    return stream;
  }
  if (stream.data.status === "paused" && stream.data.streamTs) {
    if (!input.dependencies.readChannelCredential || !input.dependencies.slackAgentStream) {
      return stream;
    }
    const chunks = slackTerminalChunks({
      body: input.body ?? "",
      status: input.run.data.status as "canceled" | "completed" | "failed",
    });
    const text = slackStreamMarkdownText(chunks);
    if (!text) return stream;
    try {
      await input.dependencies.slackAgentStream.update(
        await slackAgentStreamToken(input.dependencies, stream),
        { channel: stream.data.channelId, text, ts: stream.data.streamTs },
      );
      const stopped = await writeRecord(
        input.dependencies,
        nextRecord(stream, { status: "stopped" }, input.dependencies.now?.() ?? new Date()),
        stream,
      );
      await reconcileSuppressedFallback(input.dependencies, stopped);
      return stopped;
    } catch (cause) {
      if (cause instanceof SlackAgentStreamAuthorizationError) {
        return markFailed(input.dependencies, stream, cause, false);
      }
      if (cause instanceof SlackAgentStreamApiError && cause.safeToFallback) {
        const failed = await markFailed(input.dependencies, stream, cause, true);
        await persistTerminalFallback(input.dependencies, input.run, failed, chunks);
        return failed;
      }
      throw cause;
    }
  }
  if (stream.data.status !== "streaming" || !stream.data.streamTs) return stream;
  if (!input.dependencies.readChannelCredential || !input.dependencies.slackAgentStream)
    return stream;
  const body = input.body ?? "";
  const chunks = slackTerminalChunks({
    body,
    status: input.run.data.status as "canceled" | "completed" | "failed",
  });
  try {
    await input.dependencies.slackAgentStream.stop(
      await slackAgentStreamToken(input.dependencies, stream),
      {
        channel: stream.data.channelId,
        chunks,
        ts: stream.data.streamTs,
      },
    );
    const stopped = await writeRecord(
      input.dependencies,
      nextRecord(stream, { status: "stopped" }, input.dependencies.now?.() ?? new Date()),
      stream,
    );
    await reconcileSuppressedFallback(input.dependencies, stopped);
    await replaceProgressWithAnswer(input.dependencies, stopped, chunks);
    return stopped;
  } catch (cause) {
    if (cause instanceof SlackAgentStreamAuthorizationError) {
      return markFailed(input.dependencies, stream, cause, false);
    }
    if (
      cause instanceof SlackAgentStreamApiError &&
      (cause.code === "message_not_in_streaming_state" || cause.code === "stopped_by_user")
    ) {
      const text = slackStreamMarkdownText(chunks);
      if (!text) throw cause;
      try {
        await input.dependencies.slackAgentStream.update(
          await slackAgentStreamToken(input.dependencies, stream),
          {
            channel: stream.data.channelId,
            text,
            ts: stream.data.streamTs,
          },
        );
        const stopped = await writeRecord(
          input.dependencies,
          nextRecord(stream, { status: "stopped" }, input.dependencies.now?.() ?? new Date()),
          stream,
        );
        await reconcileSuppressedFallback(input.dependencies, stopped);
        return stopped;
      } catch (updateCause) {
        if (
          updateCause instanceof SlackAgentStreamApiError &&
          updateCause.code === "message_not_modified"
        ) {
          const stopped = await writeRecord(
            input.dependencies,
            nextRecord(stream, { status: "stopped" }, input.dependencies.now?.() ?? new Date()),
            stream,
          );
          await reconcileSuppressedFallback(input.dependencies, stopped);
          return stopped;
        }
        if (updateCause instanceof SlackAgentStreamApiError && updateCause.safeToFallback) {
          const failed = await markFailed(input.dependencies, stream, updateCause, true);
          await persistTerminalFallback(input.dependencies, input.run, failed, chunks);
          return failed;
        }
        throw updateCause;
      }
    }
    if (cause instanceof SlackAgentStreamApiError && cause.safeToFallback) {
      const failed = await markFailed(input.dependencies, stream, cause, true);
      await persistTerminalFallback(input.dependencies, input.run, failed, chunks);
      return failed;
    }
    throw cause;
  }
}

export async function pauseSlackAgentStream(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
) {
  await drainSlackAgentProgressBudget(dependencies, run.data.id);
  const stream = await loadSlackAgentStream(dependencies, run);
  if (!stream || stream.data.status !== "streaming" || !stream.data.streamTs) return stream;
  if (!dependencies.readChannelCredential || !dependencies.slackAgentStream) return stream;
  const waitingText = "Waiting for the next step before continuing.";
  try {
    await dependencies.slackAgentStream.stop(await slackAgentStreamToken(dependencies, stream), {
      channel: stream.data.channelId,
      chunks: [{ text: waitingText, type: "markdown_text" }],
      ts: stream.data.streamTs,
    });
    return writeRecord(
      dependencies,
      nextRecord(
        stream,
        { fallbackAllowed: false, status: "paused" },
        dependencies.now?.() ?? new Date(),
      ),
      stream,
    );
  } catch (cause) {
    if (cause instanceof SlackAgentStreamAuthorizationError) {
      return markFailed(dependencies, stream, cause, false);
    }
    if (
      cause instanceof SlackAgentStreamApiError &&
      (cause.code === "message_not_in_streaming_state" || cause.code === "stopped_by_user")
    ) {
      try {
        await dependencies.slackAgentStream.update(
          await slackAgentStreamToken(dependencies, stream),
          {
            channel: stream.data.channelId,
            text: waitingText,
            ts: stream.data.streamTs,
          },
        );
        return writeRecord(
          dependencies,
          nextRecord(
            stream,
            { fallbackAllowed: false, status: "paused" },
            dependencies.now?.() ?? new Date(),
          ),
          stream,
        );
      } catch (updateCause) {
        if (updateCause instanceof SlackAgentStreamAuthorizationError) {
          return markFailed(dependencies, stream, updateCause, false);
        }
        if (
          updateCause instanceof SlackAgentStreamApiError &&
          updateCause.code === "message_not_modified"
        ) {
          return writeRecord(
            dependencies,
            nextRecord(
              stream,
              { fallbackAllowed: false, status: "paused" },
              dependencies.now?.() ?? new Date(),
            ),
            stream,
          );
        }
        if (updateCause instanceof SlackAgentStreamApiError && updateCause.safeToFallback) {
          return markFailed(dependencies, stream, updateCause, true);
        }
        throw updateCause;
      }
    }
    if (cause instanceof SlackAgentStreamApiError && cause.safeToFallback) {
      return markFailed(dependencies, stream, cause, true);
    }
    throw cause;
  }
}
