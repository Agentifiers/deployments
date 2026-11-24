/**
 * Merges the run lists of an agent's deployments into one list. `GET /v1/runs` lists one
 * deployment at a time, in its index order: status descending (`waiting-for-*`, `running`,
 * `queued`, `failed`, `completed`, `canceled`), then most recently updated first. Merging every
 * deployment's stream by that same order keeps the merged list in it; with a status filter it is
 * simply newest update first.
 *
 * A run may be emitted only while no unfinished stream has an empty buffer, because that stream's
 * next page could hold a run that sorts first. Filtered pages can be short or empty and still carry
 * a cursor, so a stream stays pending until a page with runs arrives or its cursor runs out.
 */

/** Runs per merged page; each deployment's page is read with the same limit. */
export const RUN_PAGE_SIZE = 25;

export interface MergeableRun {
  readonly id: string;
  readonly status: string;
  readonly updatedAt: string;
}

interface RunStream<Run extends MergeableRun> {
  readonly buffer: readonly Run[];
  readonly deploymentId: string;
  /** Cursor of the next page; `undefined` before the first page. */
  readonly cursor: string | undefined;
  readonly exhausted: boolean;
}

export interface RunMergeState<Run extends MergeableRun> {
  readonly streams: readonly RunStream<Run>[];
}

export interface RunStreamPage<Run extends MergeableRun> {
  readonly deploymentId: string;
  readonly nextCursor: string | undefined;
  readonly runs: readonly Run[];
}

/** One request the merge needs before it can emit more runs. */
export interface RunStreamRequest {
  readonly cursor: string | undefined;
  readonly deploymentId: string;
}

/** The runtime index sort key (`RUN#<status>#<updatedAt>#<id>`), compared descending. */
const sortKey = (run: MergeableRun) => `${run.status}#${run.updatedAt}#${run.id}`;

export function initialRunMerge<Run extends MergeableRun>(
  deploymentIds: readonly string[],
): RunMergeState<Run> {
  return {
    streams: [...new Set(deploymentIds)].map((deploymentId) => ({
      buffer: [],
      cursor: undefined,
      deploymentId,
      exhausted: false,
    })),
  };
}

/** Streams whose next page must be read before the merge can continue. */
export function pendingRequests<Run extends MergeableRun>(
  state: RunMergeState<Run>,
): RunStreamRequest[] {
  return state.streams
    .filter((stream) => !stream.exhausted && stream.buffer.length === 0)
    .map(({ cursor, deploymentId }) => ({ cursor, deploymentId }));
}

export function isMergeDone<Run extends MergeableRun>(state: RunMergeState<Run>) {
  return state.streams.every((stream) => stream.exhausted && stream.buffer.length === 0);
}

/** Appends fetched pages to their streams; a page without a cursor ends its stream. */
export function absorbPages<Run extends MergeableRun>(
  state: RunMergeState<Run>,
  pages: readonly RunStreamPage<Run>[],
): RunMergeState<Run> {
  const byDeployment = new Map(pages.map((page) => [page.deploymentId, page] as const));
  return {
    streams: state.streams.map((stream) => {
      const page = byDeployment.get(stream.deploymentId);
      if (!page || stream.exhausted) return stream;
      return {
        buffer: [...stream.buffer, ...page.runs],
        cursor: page.nextCursor,
        deploymentId: stream.deploymentId,
        exhausted: page.nextCursor === undefined,
      };
    }),
  };
}

/**
 * Emits up to `limit` runs in index order, stopping early when a stream needs another page. A run
 * whose status changes while the list is open can move within its deployment's index and appear
 * again on a later page; callers drop repeated IDs when flattening pages.
 */
export function drainRuns<Run extends MergeableRun>(
  state: RunMergeState<Run>,
  limit: number,
): { readonly runs: Run[]; readonly state: RunMergeState<Run> } {
  const streams = state.streams.map((stream) => ({ ...stream, buffer: [...stream.buffer] }));
  const runs: Run[] = [];
  while (runs.length < limit) {
    if (streams.some((stream) => !stream.exhausted && stream.buffer.length === 0)) break;
    let next: (typeof streams)[number] | undefined;
    for (const stream of streams) {
      const head = stream.buffer[0];
      if (head === undefined) continue;
      if (next === undefined || sortKey(head) > sortKey(next.buffer[0]!)) next = stream;
    }
    if (next === undefined) break;
    runs.push(next.buffer.shift()!);
  }
  return { runs, state: { streams } };
}
