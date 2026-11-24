import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { threadRunPagesQuery, transcriptPagesQuery } from "../../data/runtime-queries.ts";
import { openThreadStreamFn } from "../../data/thread-stream.ts";
import {
  applyStreamFrame,
  createSseFrameReader,
  EMPTY_LIVE_THREAD,
  foldStreamEvents,
  grantNeedsRenewal,
  streamReadUrl,
  type LiveDraft,
  type LiveStatus,
  type StreamCursorState,
  type StreamEventLike,
  type StreamPosition,
  type ThreadStreamGrant,
} from "../../runs/thread-stream.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { sleep } from "../../sleep.ts";

export interface ThreadStreamView {
  readonly status: LiveStatus;
  readonly drafts: readonly LiveDraft[];
}

interface StreamReader {
  readonly openGrant: () => Promise<ThreadStreamGrant>;
  readonly onEvents: (events: readonly StreamEventLike[]) => void;
  readonly onStatus: (status: LiveStatus) => void;
  readonly signal: AbortSignal;
}

/** A stream the effect stopped, and the refresh that settles its drafts. */
interface StoppedStream {
  readonly threadId: string;
  readonly finish: () => void;
}

const CONNECTING: ThreadStreamView = { drafts: [], status: "connecting" };
const GRANT_RETRY_MS = 30_000;
/** The waits after the first consecutive failed reads; later failures wait the maximum. */
const READ_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];
const MAX_READ_BACKOFF_MS = 30_000;
const FAILURES_UNTIL_UNAVAILABLE = 3;
/** Reads start at least this far apart, however soon a response ends. */
const MIN_CONNECT_INTERVAL_MS = 1_000;
const REFRESH_COALESCE_MS = 300;

/**
 * Reads the thread's stream while `enabled`: the assistant text streaming into messages, and a
 * coalesced refetch of the transcript and runs when an event changes them. An effect rather than a
 * query, because invalidation and hover preloading would mint stream tokens.
 */
export function useThreadStream({
  enabled,
  scope,
  threadId,
}: Readonly<{ enabled: boolean; scope: EnvironmentScope; threadId: string }>): ThreadStreamView {
  const queryClient = useQueryClient();
  const [view, setView] = useState(CONNECTING);
  // Counts the streams started; a stopped stream's refresh may land after a newer one started.
  const generation = useRef(0);
  // Only the effect run that follows `enabled` turning false finishes the stopped stream. An
  // unmount runs no effect, so it skips the refresh.
  const stopped = useRef<StoppedStream>(undefined);
  const { environmentId, organizationId, projectId } = scope;

  useEffect(() => {
    const previous = stopped.current;
    stopped.current = undefined;
    if (!enabled) {
      if (previous?.threadId === threadId) previous.finish();
      else setView(CONNECTING);
      return undefined;
    }
    generation.current += 1;
    const stream = generation.current;
    const controller = new AbortController();
    const { signal } = controller;
    const streamScope = { environmentId, organizationId, projectId };
    let live = EMPTY_LIVE_THREAD;
    // Drafts a finalized message or a terminal run removed stay visible until the refetch that
    // brings the message lands; dropping them first would blank the text for a round trip.
    const settling = new Map<string, LiveDraft>();
    // Each refresh waits for the one before: a refetch started while another is in flight cancels
    // it, so a steady run of events would otherwise never let one land.
    let lastRefresh = Promise.resolve();
    let refreshQueued = false;
    let caughtUp = false;
    setView(CONNECTING);

    const publishDrafts = () => {
      const drafts = [
        ...[...settling.values()].filter((draft) => !live.drafts.has(draft.messageId)),
        ...live.drafts.values(),
      ];
      setView((current) => ({ ...current, drafts }));
    };
    // The transcript refetches before the runs, because a terminal run turns the stream off.
    const refetch = async () => {
      await queryClient.invalidateQueries({
        queryKey: transcriptPagesQuery(streamScope, threadId).queryKey,
      });
      await queryClient.invalidateQueries({
        queryKey: threadRunPagesQuery(streamScope, threadId).queryKey,
      });
    };
    // Events while a refresh waits out the window join it; events during its refetch queue one more.
    const refresh = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      const previousRefresh = lastRefresh;
      lastRefresh = (async () => {
        await Promise.all([previousRefresh, sleep(REFRESH_COALESCE_MS, signal)]);
        refreshQueued = false;
        if (signal.aborted) return;
        const settled = [...settling.keys()];
        await refetch();
        if (signal.aborted) return;
        for (const messageId of settled) settling.delete(messageId);
        publishDrafts();
      })();
    };

    void readThreadStream({
      onEvents: (events) => {
        const folded = foldStreamEvents(live, events);
        for (const draft of live.drafts.values()) {
          if (!folded.state.drafts.has(draft.messageId)) settling.set(draft.messageId, draft);
        }
        live = folded.state;
        if (folded.refresh) refresh();
        publishDrafts();
      },
      onStatus: (status) => {
        // The first grant's offset is newer than the transcript and runs on screen, so one refetch
        // picks up whatever was published between that snapshot and the offset.
        if (status === "live" && !caughtUp) {
          caughtUp = true;
          refresh();
        }
        setView((current) => (current.status === status ? current : { ...current, status }));
      },
      openGrant: () => openThreadStreamFn({ data: { scope: streamScope, threadId }, signal }),
      signal,
    });
    return () => {
      controller.abort();
      // The runs can show the run finished before its message reaches the transcript on screen, so
      // one more refetch follows the one in flight, and the drafts stay until it lands.
      stopped.current = {
        finish: () => {
          setView((current) =>
            current.status === "connecting" ? current : { ...current, status: "connecting" },
          );
          void lastRefresh.then(refetch).then(() => {
            if (generation.current === stream) setView(CONNECTING);
          });
        },
        threadId,
      };
    };
  }, [enabled, environmentId, organizationId, projectId, queryClient, threadId]);

  return view;
}

/**
 * Reads from the grant's offset until aborted or the stream closes. Renewals keep the reader's
 * own position: a new grant's offset is the stream's tail and would skip what arrived meanwhile.
 */
async function readThreadStream(reader: StreamReader): Promise<void> {
  const { onEvents, onStatus, signal } = reader;
  let grant = await grantWhenAvailable(reader);
  if (grant === undefined) return;
  let position: StreamPosition = { offset: grant.offset };
  let failures = 0;
  // A 401 for a token that has already opened a read means it expired, so the reader renews at
  // once; a 401 for a token minted moments ago backs off like any other failure.
  let tokenWorked = false;
  let connectedAt = Number.NEGATIVE_INFINITY;
  while (!signal.aborted) {
    const pause = connectedAt + MIN_CONNECT_INTERVAL_MS - Date.now();
    if (pause > 0) await sleep(pause, signal);
    if (grant === undefined || grantNeedsRenewal(grant, Date.now() - grant.receivedAt)) {
      grant = await grantWhenAvailable(reader);
      if (grant === undefined) return;
      tokenWorked = false;
    }
    connectedAt = Date.now();
    const response = await fetch(streamReadUrl(grant.streamUrl, position), {
      cache: "no-store",
      headers: { authorization: `Bearer ${grant.accessToken}` },
      redirect: "error",
      signal,
    }).catch(() => undefined);
    if (response?.ok && response.body) {
      const read = await readEvents(response.body, position, (committed) => {
        failures = 0;
        tokenWorked = true;
        onStatus("live");
        if (committed.length > 0) onEvents(committed);
      });
      position = read.state.position;
      if (read.state.closed) {
        onStatus("unavailable");
        return;
      }
      if (read.ended) continue;
    } else if (response?.status === 401) {
      grant = undefined;
      if (tokenWorked) continue;
    }
    if (signal.aborted) return;
    failures += 1;
    if (failures >= FAILURES_UNTIL_UNAVAILABLE) onStatus("unavailable");
    await sleep(READ_BACKOFF_MS[failures - 1] ?? MAX_READ_BACKOFF_MS, signal);
  }
}

/** A grant stamped with when it arrived, because renewal counts its lifetime on this clock. */
async function grantWhenAvailable({ onStatus, openGrant, signal }: StreamReader) {
  while (!signal.aborted) {
    try {
      return { ...(await openGrant()), receivedAt: Date.now() };
    } catch {
      if (signal.aborted) break;
      onStatus("unavailable");
      await sleep(GRANT_RETRY_MS, signal);
    }
  }
  return undefined;
}

/**
 * Reads one SSE response and hands each control frame's committed batch to `onCommit`. `ended`
 * means the body finished cleanly after a control frame moved the position; a body that ends
 * without one counts as a failed read.
 */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  from: StreamPosition,
  onCommit: (committed: readonly StreamEventLike[]) => void,
): Promise<{ readonly ended: boolean; readonly state: StreamCursorState }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames = createSseFrameReader();
  let state: StreamCursorState = { closed: false, pending: [], position: from };
  let sawControl = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ended: sawControl, state };
      for (const frame of frames.push(decoder.decode(value, { stream: true }))) {
        const applied = applyStreamFrame(state, frame);
        state = applied.state;
        if (applied.committed === undefined) continue;
        sawControl = true;
        onCommit(applied.committed);
        if (state.closed) {
          await reader.cancel();
          return { ended: true, state };
        }
      }
    }
  } catch {
    return { ended: false, state };
  }
}
