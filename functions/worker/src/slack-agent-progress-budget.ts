const MAX_SLACK_PROGRESS_REQUESTS_PER_RUN = 60;
const SLACK_PROGRESS_REQUEST_DEADLINE_MS = 50;

interface ProgressState {
  closed: boolean;
  count: number;
  inFlight: Promise<void> | undefined;
  pending: (() => Promise<void>) | undefined;
}

const requestStates = new WeakMap<object, Map<string, ProgressState>>();

function startProgressOperation(
  state: ProgressState,
  operation: () => Promise<void>,
): Promise<void> {
  state.count += 1;
  const inFlight = operation()
    .catch(() => undefined)
    .finally(() => {
      if (state.inFlight !== inFlight) return;
      state.inFlight = undefined;
      const pending = state.pending;
      state.pending = undefined;
      if (!state.closed && pending && state.count < MAX_SLACK_PROGRESS_REQUESTS_PER_RUN) {
        void startProgressOperation(state, pending);
      }
    });
  state.inFlight = inFlight;
  return inFlight;
}

export async function withinSlackAgentProgressBudget(
  owner: object,
  runGeneration: string,
  operation: () => Promise<void>,
): Promise<void> {
  const states = requestStates.get(owner) ?? new Map<string, ProgressState>();
  requestStates.set(owner, states);
  const state = states.get(runGeneration) ?? {
    closed: false,
    count: 0,
    inFlight: undefined,
    pending: undefined,
  };
  states.set(runGeneration, state);
  if (state.closed) return;
  if (state.inFlight) {
    state.pending = operation;
    return;
  }
  if (state.count >= MAX_SLACK_PROGRESS_REQUESTS_PER_RUN) return;
  const inFlight = startProgressOperation(state, operation);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    inFlight,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, SLACK_PROGRESS_REQUEST_DEADLINE_MS);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}

export async function drainSlackAgentProgressBudget(owner: object, runId: string): Promise<void> {
  const states = requestStates.get(owner);
  if (!states) return;
  const inFlight: Promise<void>[] = [];
  for (const [key, state] of states) {
    if (!key.startsWith(`${runId}:`)) continue;
    state.closed = true;
    state.pending = undefined;
    if (state.inFlight) inFlight.push(state.inFlight);
  }
  await Promise.allSettled(inFlight);
}

export function clearSlackAgentProgressBudget(owner: object, runId: string): void {
  const states = requestStates.get(owner);
  if (!states) return;
  for (const key of states.keys()) if (key.startsWith(`${runId}:`)) states.delete(key);
  if (states.size === 0) requestStates.delete(owner);
}
