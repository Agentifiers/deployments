import { STATUS_REFRESH_MS } from "../data/refresh.ts";
import {
  automationRecord,
  automationRow,
  type AutomationEntry,
  type AutomationFilters,
  type AutomationOrigin,
  type AutomationRecord,
  type AutomationRow,
  type AutomationStatus,
  type LastFire,
} from "./automation-state.ts";

export const LIST_PAGE_SIZE = 25;
export const THREAD_PAGE_SIZE = 10;

export interface AutomationListing {
  /** Every row and fire is judged at this instant. */
  readonly listedAt: string;
  /**
   * One record per ID (highest version wins), ordered by status rank, then next fire judged
   * without a fire, then newest update.
   */
  readonly records: readonly AutomationRecord[];
}

/**
 * The list (`deploymentIds` absent), the agent tab (its deployments), or a thread (bound to it or
 * created in it, every status).
 */
export type AutomationView =
  | {
      readonly kind: "list";
      readonly filters: AutomationFilters;
      readonly deploymentIds?: readonly string[];
    }
  | { readonly kind: "thread"; readonly threadId: string };

export interface ViewWindow {
  readonly records: readonly AutomationRecord[];
  /** List views: matching archived or disabled records left out because `show` is not `all`. */
  readonly hidden: number;
  readonly nextOffset?: number;
}

export interface AutomationPage {
  readonly rows: readonly AutomationRow[];
  readonly hidden: number;
  readonly nextOffset?: number;
}

const STATUS_LISTING: Readonly<
  Record<AutomationStatus, { readonly hidden: boolean; readonly rank: number }>
> = {
  active: { hidden: false, rank: 0 },
  archived: { hidden: true, rank: 3 },
  disabled: { hidden: true, rank: 3 },
  paused: { hidden: false, rank: 2 },
  provisioning: { hidden: false, rank: 1 },
};

/** Agents create automations through tools; an agent creator without a recorded tool call still counts. */
const ORIGIN_FILTERS: Readonly<
  Record<NonNullable<AutomationFilters["origin"]>, (origin: AutomationOrigin) => boolean>
> = {
  agent: (origin) =>
    origin.kind === "agent-tool" || (origin.kind === "caller" && origin.actorType === "agent"),
  caller: (origin) => origin.kind === "caller" && origin.actorType !== "agent",
};

const NEVER: LastFire = { kind: "never" };
const NO_NEXT_FIRE = Number.MAX_SAFE_INTEGER;
/** By a minute after its time, a fire has landed and started its run. */
const FIRE_SETTLE_MS = 60_000;
const MAX_THREAD_REFRESH_MS = 60 * 60_000;

export function automationListing(
  entries: readonly AutomationEntry[],
  now: Date,
): AutomationListing {
  const newest = new Map<string, AutomationRecord>();
  for (const entry of entries) {
    const record = automationRecord(entry);
    const seen = newest.get(record.id);
    if (seen === undefined || record.version > seen.version) newest.set(record.id, record);
  }
  const records = [...newest.values()]
    .map((record) => {
      const { nextFire } = automationRow(record, NEVER, now);
      return { firesAt: nextFire.kind === "at" ? Date.parse(nextFire.at) : NO_NEXT_FIRE, record };
    })
    .toSorted(
      (left, right) =>
        STATUS_LISTING[left.record.status].rank - STATUS_LISTING[right.record.status].rank ||
        left.firesAt - right.firesAt ||
        Date.parse(right.record.updatedAt) - Date.parse(left.record.updatedAt),
    )
    .map(({ record }) => record);
  return { listedAt: now.toISOString(), records };
}

function windowAt(
  records: readonly AutomationRecord[],
  hidden: number,
  offset: number,
  size: number,
): ViewWindow {
  const end = offset + size;
  return {
    hidden,
    records: records.slice(offset, end),
    ...(end < records.length ? { nextOffset: end } : {}),
  };
}

export function viewWindow(
  listing: AutomationListing,
  view: AutomationView,
  offset: number,
): ViewWindow {
  switch (view.kind) {
    case "list": {
      const { agentDeploymentId, kind, origin, show } = view.filters;
      const owned = view.deploymentIds && new Set(view.deploymentIds);
      const matching = listing.records.filter(
        (record) =>
          (owned === undefined || owned.has(record.agentDeploymentId)) &&
          (agentDeploymentId === undefined || record.agentDeploymentId === agentDeploymentId) &&
          (kind === undefined || record.kind === kind) &&
          (origin === undefined || ORIGIN_FILTERS[origin](record.origin)),
      );
      const shown =
        show === "all"
          ? matching
          : matching.filter((record) => !STATUS_LISTING[record.status].hidden);
      return windowAt(shown, matching.length - shown.length, offset, LIST_PAGE_SIZE);
    }
    case "thread": {
      const { threadId } = view;
      const related = listing.records.filter(
        ({ origin, thread }) =>
          (thread.kind === "continues" && thread.threadId === threadId) ||
          (origin.kind === "agent-tool" && origin.threadId === threadId),
      );
      return windowAt(related, 0, offset, THREAD_PAGE_SIZE);
    }
  }
}

/**
 * Last fires a refresh can keep from `previous`: same ID and version, not `unavailable`, and no
 * fire can land without a version bump. Every heartbeat fire rewrites the heartbeat, and archived
 * or disabled automations do not fire, so active, paused, and provisioning schedules are re-read.
 */
export function keptLastFires(
  previous: readonly AutomationRow[],
  records: readonly AutomationRecord[],
): ReadonlyMap<string, LastFire> {
  const shown = new Map(previous.map((row) => [row.id, row]));
  const kept = new Map<string, LastFire>();
  for (const record of records) {
    const row = shown.get(record.id);
    if (
      row !== undefined &&
      row.version === record.version &&
      row.lastFire.kind !== "unavailable" &&
      (record.kind === "heartbeat" || record.status === "archived" || record.status === "disabled")
    ) {
      kept.set(record.id, row.lastFire);
    }
  }
  return kept;
}

/**
 * Loaded pages flattened, keeping the first row of each ID, since a Load more after SSR can come
 * from a newer listing.
 */
export function loadedRows(pages: readonly AutomationPage[]): readonly AutomationRow[] {
  const rows = new Map<string, AutomationRow>();
  for (const page of pages) {
    for (const row of page.rows) {
      if (!rows.has(row.id)) rows.set(row.id, row);
    }
  }
  return [...rows.values()];
}

/**
 * Thread view refresh: every 30 s while a row provisions; otherwise a minute after the earliest
 * next fire, clamped to 30 s through 1 h; `false` when no row has a next fire.
 */
export function threadRefreshDelay(rows: readonly AutomationRow[], now: Date): number | false {
  if (rows.some((row) => row.status === "provisioning")) return STATUS_REFRESH_MS;
  const nextFires = rows.flatMap(({ nextFire }) =>
    nextFire.kind === "at" ? [Date.parse(nextFire.at)] : [],
  );
  if (nextFires.length === 0) return false;
  const delay = Math.min(...nextFires) + FIRE_SETTLE_MS - now.getTime();
  return Math.min(Math.max(delay, STATUS_REFRESH_MS), MAX_THREAD_REFRESH_MS);
}
