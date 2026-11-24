import {
  PlatformApiError,
  type PlatformStreamPage,
  type RuntimeSdk,
  type RuntimeStreamTarget,
} from "@agentifiers/deployments-sdk";

export type RunStreamEvent = Record<string, unknown>;

export interface RunStreamPosition {
  readonly cursor?: string;
  readonly offset: string;
}

export interface ReadRunStreamOptions {
  readonly runtime: RuntimeSdk;
  readonly threadId: string;
  readonly runId: string;
  /** Follows new events over SSE until `onEvent`/`onIdle` stops or the stream closes. */
  readonly follow: boolean;
  readonly position?: RunStreamPosition;
  /** Receives each event of the run; returning true stops reading after the current page. */
  readonly onEvent: (event: RunStreamEvent) => boolean | void | Promise<boolean | void>;
  /** Called after a followed page without events for the run; returning true stops reading. */
  readonly onIdle?: () => boolean | Promise<boolean>;
}

export const TERMINAL_RUN_EVENT_TYPES: Readonly<Record<string, true>> = {
  "run.canceled": true,
  "run.completed": true,
  "run.failed": true,
};

/**
 * Reads the thread stream events of one run through a stream session and returns the position to
 * resume from. Catch-up reads page until the stream is up to date; followed reads stay on one SSE
 * stream, refreshing an expired session once between pages.
 */
export async function readRunStream(options: ReadRunStreamOptions): Promise<RunStreamPosition> {
  const { runtime, threadId, runId, follow } = options;
  let session: RuntimeStreamTarget = (await runtime.threads.createStreamSession(threadId)).data;
  let cursor = options.position?.cursor;
  let offset = options.position?.offset ?? "-1";
  const position = (): RunStreamPosition => ({ ...(cursor ? { cursor } : {}), offset });

  /** Delivers one page's run events and advances the position; true means stop reading. */
  const consume = async (page: PlatformStreamPage<RunStreamEvent>) => {
    let stop = false;
    let runEvents = 0;
    for (const event of page.items) {
      if (event.runId !== runId) continue;
      runEvents += 1;
      if ((await options.onEvent(event)) === true) stop = true;
    }
    if (page.cursor) cursor = page.cursor;
    if (page.nextOffset) offset = page.nextOffset;
    if (stop || page.closed) return true;
    return follow && runEvents === 0 && options.onIdle !== undefined && (await options.onIdle());
  };

  if (!follow) {
    while (true) {
      const previous = position();
      const page = await runtime.threads.readStreamPage<RunStreamEvent>(session, previous);
      if ((await consume(page)) || page.upToDate === true) return position();
      if (cursor === previous.cursor && offset === previous.offset) return position();
    }
  }

  let retriedExpiredSession = false;
  while (true) {
    try {
      for await (const page of runtime.threads.streamEvents<RunStreamEvent>(session, position())) {
        retriedExpiredSession = false;
        if (await consume(page)) return position();
      }
      return position();
    } catch (error) {
      const expired = error instanceof PlatformApiError && error.problem.status === 401;
      if (retriedExpiredSession || !expired) throw error;
      session = (await runtime.threads.createStreamSession(threadId)).data;
      retriedExpiredSession = true;
    }
  }
}
