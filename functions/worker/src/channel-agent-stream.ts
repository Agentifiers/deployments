import type { SlackAgentProgress } from "@deployments-ai/channel-adapters/slack";
import type { AgentPlanUpdate } from "@deployments-ai/streaming";
import { clearSlackAgentProgressBudget } from "./slack-agent-progress-budget.ts";
import {
  ensureSlackAgentStream,
  finalizeSlackAgentStream,
  pauseSlackAgentStream,
  SlackAgentStreamInitializationRetryableError,
} from "./slack-agent-stream.ts";
import { appendSlackAgentPlan, appendSlackAgentProgress } from "./slack-agent-stream-progress.ts";
import {
  ensureTeamsAgentStream,
  finalizeTeamsAgentStream,
  pauseTeamsAgentStream,
  TeamsAgentStreamInitializationRetryableError,
} from "./teams-agent-stream.ts";
import {
  appendTeamsAgentPlan,
  appendTeamsAgentProgress,
  clearTeamsAgentStreamUpdates,
} from "./teams-agent-stream-progress.ts";
import type { AgentRunWorkerDependencies, MessageRecordValue, RunRecordValue } from "./types.ts";

/**
 * Provider-neutral entry points for the live agent streams of channel-triggered runs. Each run has
 * at most one provider stream (its ingress binding's channel); every operation is offered to each
 * provider, which ignores runs that are not its own.
 */
export type ChannelAgentStreamProvider = "slack" | "teams";

interface ChannelAgentStreamFailure {
  readonly cause: unknown;
  readonly provider: ChannelAgentStreamProvider;
}

/** Runs every provider operation and reports the first failure after all have settled. */
async function settleProviders(
  operations: Readonly<Record<ChannelAgentStreamProvider, () => Promise<unknown>>>,
): Promise<ChannelAgentStreamFailure | undefined> {
  let failure: ChannelAgentStreamFailure | undefined;
  for (const provider of ["slack", "teams"] as const) {
    try {
      await operations[provider]();
    } catch (cause) {
      failure ??= { cause, provider };
    }
  }
  return failure;
}

export function isChannelAgentStreamInitializationRetryable(
  cause: unknown,
): cause is
  | SlackAgentStreamInitializationRetryableError
  | TeamsAgentStreamInitializationRetryableError {
  return (
    cause instanceof SlackAgentStreamInitializationRetryableError ||
    cause instanceof TeamsAgentStreamInitializationRetryableError
  );
}

/**
 * Starts, resumes, or reconciles the run's provider stream before execution. Every failure is a
 * provider initialization retry so the run never executes without a reconciled stream.
 *
 * A provider stream only ever exists for a run triggered through that provider's ingress, so only
 * the provider named by the trigger message's immutable ingress metadata is consulted; other runs
 * make no stream reads.
 */
export async function ensureChannelAgentStreams(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  trigger: MessageRecordValue,
  signal?: AbortSignal,
) {
  const metadata = trigger.data.metadata;
  if (metadata?.source !== "channel-ingress") return;
  if (metadata.provider === "slack_edge" || metadata.provider === "slack_cloudflare_edge") {
    try {
      await ensureSlackAgentStream(dependencies, run, trigger, signal);
    } catch (cause) {
      throw new SlackAgentStreamInitializationRetryableError(cause);
    }
  } else if (metadata.provider === "teams_bot_framework") {
    try {
      await ensureTeamsAgentStream(dependencies, run, trigger, signal);
    } catch (cause) {
      throw new TeamsAgentStreamInitializationRetryableError(cause);
    }
  }
}

export async function pauseChannelAgentStreams(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
) {
  const failure = await settleProviders({
    slack: () => pauseSlackAgentStream(dependencies, run),
    teams: () => pauseTeamsAgentStream(dependencies, run),
  });
  if (failure) throw failure.cause;
}

export async function finalizeChannelAgentStreams(input: {
  readonly body?: string;
  readonly dependencies: AgentRunWorkerDependencies;
  readonly run: RunRecordValue;
}) {
  const failure = await settleProviders({
    slack: () => finalizeSlackAgentStream(input),
    teams: () => finalizeTeamsAgentStream(input),
  });
  if (failure) throw failure.cause;
}

/**
 * Reconciles the streams of a run recovered from an expired lease: paused runs pause their
 * segment, terminal runs finalize it (completed runs with `completedBody`). Returns the first
 * provider whose reconciliation failed so the caller can requeue it.
 */
export async function reconcileRecoveredChannelAgentStreams(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  completedBody: () => Promise<string>,
): Promise<ChannelAgentStreamProvider | undefined> {
  if (run.data.status === "waiting-for-approval" || run.data.status === "waiting-for-tool") {
    return (
      await settleProviders({
        slack: () => pauseSlackAgentStream(dependencies, run),
        teams: () => pauseTeamsAgentStream(dependencies, run),
      })
    )?.provider;
  }
  let body: Promise<string> | undefined;
  const terminalBody = async () =>
    run.data.status === "completed" ? { body: await (body ??= completedBody()) } : {};
  return (
    await settleProviders({
      slack: async () => finalizeSlackAgentStream({ ...(await terminalBody()), dependencies, run }),
      teams: async () => finalizeTeamsAgentStream({ ...(await terminalBody()), dependencies, run }),
    })
  )?.provider;
}

/** Cosmetic progress for the run's live stream; never throws and never blocks the run long. */
export async function appendChannelAgentProgress(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  progress: SlackAgentProgress,
) {
  await Promise.allSettled([
    appendSlackAgentProgress(dependencies, run, progress),
    appendTeamsAgentProgress(dependencies, run, progress),
  ]);
}

export async function appendChannelAgentPlan(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  runExecutionVersion: number,
  update: AgentPlanUpdate,
) {
  await Promise.allSettled([
    appendSlackAgentPlan(dependencies, run, runExecutionVersion, update),
    appendTeamsAgentPlan(dependencies, run, runExecutionVersion, update),
  ]);
}

/** Drops in-process progress state once the run's outcome has been published. */
export function clearChannelAgentStreamProgress(owner: object, runId: string) {
  clearSlackAgentProgressBudget(owner, runId);
  clearTeamsAgentStreamUpdates(owner, runId);
}
