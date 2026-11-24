import {
  TEAMS_STREAM_MAX_DURATION_MS,
  TEAMS_STREAM_MIN_REQUEST_INTERVAL_MS,
  teamsAgentPlanText,
  teamsProgressText,
  teamsStreamInformativeActivity,
  type TeamsAgentProgress,
} from "@deployments-ai/channel-adapters/teams";
import type { PlatformRecord } from "@deployments-ai/db";
import type { AgentPlanUpdate } from "@deployments-ai/streaming";
import { teamsAgentStreamAuthorization } from "./teams-agent-stream-authorization.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

type TeamsStream = Extract<PlatformRecord, { readonly itemType: "teams-agent-stream" }>;

const MAX_TEAMS_STREAM_UPDATES_PER_RUN = 60;
/** Progress publication never holds the agent run longer than this. */
const TEAMS_STREAM_UPDATE_DEADLINE_MS = 50;
/** Informative updates stop this long before Teams closes a stream at its duration limit. */
const TEAMS_STREAM_WINDOW_SAFETY_MARGIN_MS = 10_000;

/**
 * In-process informative-update state of one streaming Teams segment. Teams numbers stream
 * requests and throttles them, so the next update is sent only after the previous one succeeded
 * and at least the minimum interval later; intermediate texts coalesce to the latest.
 */
interface TeamsStreamUpdates {
  closed: boolean;
  count: number;
  lastRequestAt: number;
  pending: string | undefined;
  planned: boolean;
  pump: Promise<void> | undefined;
  sequence: number;
  readonly stream: TeamsStream & { readonly data: { readonly streamId: string } };
  wake: (() => void) | undefined;
}

const updateStates = new WeakMap<object, Map<string, TeamsStreamUpdates>>();

/** Whether a stream segment is too close to Teams' two-minute limit to accept more requests. */
export function teamsStreamWindowElapsed(
  dependencies: AgentRunWorkerDependencies,
  stream: TeamsStream,
) {
  if (!stream.data.streamStartedAt) return false;
  const elapsed =
    (dependencies.now?.() ?? new Date()).getTime() - Date.parse(stream.data.streamStartedAt);
  return elapsed >= TEAMS_STREAM_MAX_DURATION_MS - TEAMS_STREAM_WINDOW_SAFETY_MARGIN_MS;
}

/**
 * Tracks a segment this process just started (its start request used sequence 1). Segments that
 * another process started are never tracked: their sequence is unknown, so they only finalize.
 */
export function trackTeamsAgentStreamUpdates(
  owner: object,
  stream: TeamsStream,
  options: { readonly planned: boolean },
) {
  const streamId = stream.data.streamId;
  if (stream.data.status !== "streaming" || !streamId) return;
  const states = updateStates.get(owner) ?? new Map<string, TeamsStreamUpdates>();
  updateStates.set(owner, states);
  const previous = states.get(stream.data.runId);
  if (previous) closeUpdates(previous);
  states.set(stream.data.runId, {
    closed: false,
    count: 0,
    lastRequestAt: performance.now(),
    pending: undefined,
    planned: options.planned,
    pump: undefined,
    sequence: 1,
    stream: { ...stream, data: { ...stream.data, streamId } },
    wake: undefined,
  });
}

function closeUpdates(state: TeamsStreamUpdates) {
  state.closed = true;
  state.pending = undefined;
  state.wake?.();
}

async function pumpUpdates(dependencies: AgentRunWorkerDependencies, state: TeamsStreamUpdates) {
  const client = dependencies.teamsAgentStream;
  while (client && !state.closed && state.pending !== undefined) {
    const wait = state.lastRequestAt + TEAMS_STREAM_MIN_REQUEST_INTERVAL_MS - performance.now();
    if (wait > 0) {
      const paced = Promise.withResolvers<void>();
      const timer = setTimeout(paced.resolve, wait);
      state.wake = () => {
        clearTimeout(timer);
        paced.resolve();
      };
      await paced.promise;
      state.wake = undefined;
    }
    const text = state.pending;
    if (state.closed || text === undefined) break;
    if (
      state.count >= MAX_TEAMS_STREAM_UPDATES_PER_RUN ||
      teamsStreamWindowElapsed(dependencies, state.stream)
    ) {
      closeUpdates(state);
      break;
    }
    state.pending = undefined;
    state.count += 1;
    const sequence = state.sequence + 1;
    try {
      const { credentials } = await teamsAgentStreamAuthorization(dependencies, state.stream);
      if (state.closed) break;
      await client.sendActivity({
        activity: teamsStreamInformativeActivity({
          sequence,
          streamId: state.stream.data.streamId,
          text,
        }),
        conversationId: state.stream.data.conversationId,
        credentials,
        serviceUrl: state.stream.data.serviceUrl,
      });
      state.sequence = sequence;
      state.lastRequestAt = performance.now();
    } catch {
      // Informative updates are cosmetic. After a failure the stream sequence is uncertain, so the
      // segment stops updating and only its final message is sent.
      closeUpdates(state);
    }
  }
}

async function requestUpdate(
  dependencies: AgentRunWorkerDependencies,
  state: TeamsStreamUpdates,
  text: string,
) {
  if (
    state.closed ||
    state.count >= MAX_TEAMS_STREAM_UPDATES_PER_RUN ||
    teamsStreamWindowElapsed(dependencies, state.stream)
  ) {
    return;
  }
  state.pending = text;
  if (state.pump) return;
  const immediate = performance.now() - state.lastRequestAt >= TEAMS_STREAM_MIN_REQUEST_INTERVAL_MS;
  const pump = pumpUpdates(dependencies, state).finally(() => {
    state.pump = undefined;
  });
  state.pump = pump;
  if (!immediate) return;
  const deadline = Promise.withResolvers<void>();
  const timeout = setTimeout(deadline.resolve, TEAMS_STREAM_UPDATE_DEADLINE_MS);
  await Promise.race([pump, deadline.promise]);
  clearTimeout(timeout);
}

export async function appendTeamsAgentProgress(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  progress: TeamsAgentProgress,
) {
  const state = updateStates.get(dependencies)?.get(run.data.id);
  // The plan is the canonical status once the generation has one; tool cards are for unplanned runs.
  if (!state || state.planned) return;
  const text = teamsProgressText(progress);
  if (text) await requestUpdate(dependencies, state, text);
}

export async function appendTeamsAgentPlan(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  runExecutionVersion: number,
  update: AgentPlanUpdate,
) {
  const state = updateStates.get(dependencies)?.get(run.data.id);
  if (!state || state.stream.data.runExecutionVersion !== runExecutionVersion) return;
  state.planned = true;
  const text = teamsAgentPlanText(update);
  if (text) await requestUpdate(dependencies, state, text);
}

/** Stops informative updates for a run and waits for an in-flight request before finalizing. */
export async function drainTeamsAgentStreamUpdates(owner: object, runId: string) {
  const state = updateStates.get(owner)?.get(runId);
  if (!state) return;
  closeUpdates(state);
  await state.pump;
}

export function clearTeamsAgentStreamUpdates(owner: object, runId: string) {
  const states = updateStates.get(owner);
  if (!states) return;
  const state = states.get(runId);
  if (state) closeUpdates(state);
  states.delete(runId);
  if (states.size === 0) updateStates.delete(owner);
}
