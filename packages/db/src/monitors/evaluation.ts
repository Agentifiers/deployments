import type { Ulid } from "../ids.ts";
import type { MonitorRecord } from "../records/monitors.ts";
import type { SemanticEventData } from "../records/events.ts";
import { matchMonitorEvent, MONITOR_KINDS } from "./kinds.ts";
import type { CommittedTransition, MonitorPersistence, MonitorSnapshot } from "./persistence.ts";
import {
  decideMonitorTransition,
  monitorNotifies,
  renotifyDue,
  type MonitorObservation,
} from "./state-machine.ts";

type SemanticEvent = typeof SemanticEventData.Type;

const MAX_COMMIT_ATTEMPTS = 5;

/**
 * Reads the facts a current-state or hot-plane kind depends on. Counting and one-shot kinds are
 * observed from stored signals and need no observer.
 */
export type MonitorObserver = (monitor: MonitorRecord, now: Date) => Promise<MonitorObservation>;

export interface MonitorEvaluationDependencies {
  readonly monitors: MonitorPersistence;
  readonly now: () => Date;
  /** Observers by kind; a kind without one is observed from signals. */
  readonly observe: Partial<Record<MonitorRecord["data"]["condition"]["kind"], MonitorObserver>>;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const WINDOW_NOUN = {
  "run-failures": "failed run",
  "schedule-problems": "skipped or expired schedule fire",
  "tool-failures": "failed tool call",
} as const;

/** Counting kinds: the number of signals in the window against the threshold. */
async function observeWindow(
  monitors: MonitorPersistence,
  monitor: MonitorRecord,
  now: Date,
): Promise<MonitorObservation> {
  const condition = monitor.data.condition;
  if (
    condition.kind !== "run-failures" &&
    condition.kind !== "tool-failures" &&
    condition.kind !== "schedule-problems"
  ) {
    throw new TypeError(`${condition.kind} is not a counting kind.`);
  }
  const since = new Date(now.getTime() - condition.windowMinutes * 60_000);
  const count = await monitors.countSignals(monitor, since);
  return count >= condition.threshold
    ? {
        firing: true,
        summary: `${plural(count, WINDOW_NOUN[condition.kind])} in the last ${plural(
          condition.windowMinutes,
          "minute",
        )} (threshold ${condition.threshold}).`,
        value: count,
      }
    : { firing: false };
}

/** One-shot kinds stay firing until the time the triggering event named. */
function observeOneShot(snapshot: MonitorSnapshot, now: Date): MonitorObservation {
  const state = snapshot.state;
  if (state?.data.phase !== "firing" || state.data.firingUntil === undefined)
    return { firing: false };
  return Date.parse(state.data.firingUntil) > now.getTime()
    ? { firing: true, summary: "Still above the threshold." }
    : { firing: false };
}

/** Why an evaluation runs: the sweep observes everything; an event may carry a one-shot fact. */
export type MonitorEvaluationTrigger =
  | { readonly kind: "sweep" }
  | { readonly kind: "event"; readonly oneShot?: MonitorObservation };

/**
 * A new signal only adds to a firing window, so an event cannot change a firing counting monitor
 * unless a repeat notification is due; clearing it is the sweep's job.
 */
function eventCannotChange(snapshot: MonitorSnapshot, now: Date) {
  const { monitor, state } = snapshot;
  return (
    state?.data.phase === "firing" &&
    monitor.data.status !== "archived" &&
    !(monitorNotifies(monitor, now) && renotifyDue(monitor, state, now))
  );
}

/**
 * Evaluates one monitor and commits at most one transition. The decision is re-derived from a
 * fresh strongly consistent read on every attempt, and the commit is conditioned on the state
 * version that read saw, so a retry, a concurrent sweep, or a duplicate event finds the work done
 * and converges on the same incident instead of opening another.
 */
export async function evaluateMonitor(
  dependencies: MonitorEvaluationDependencies,
  target: { readonly monitorId: Ulid; readonly organizationId: Ulid },
  trigger: MonitorEvaluationTrigger = { kind: "sweep" },
): Promise<CommittedTransition | undefined> {
  const oneShot = trigger.kind === "event" ? trigger.oneShot : undefined;
  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const snapshot = await dependencies.monitors.snapshot(target.organizationId, target.monitorId);
    if (!snapshot) return undefined;
    const now = dependencies.now();
    const { monitor } = snapshot;
    const source = MONITOR_KINDS[monitor.data.condition.kind].source.type;
    if (trigger.kind === "event" && source === "window-count" && eventCannotChange(snapshot, now))
      return undefined;
    const observer = dependencies.observe[monitor.data.condition.kind];
    const observation: MonitorObservation =
      monitor.data.status === "archived"
        ? { firing: false }
        : source === "window-count"
          ? await observeWindow(dependencies.monitors, monitor, now)
          : source === "one-shot"
            ? (oneShot ?? observeOneShot(snapshot, now))
            : observer
              ? await observer(monitor, now)
              : { firing: false };
    const transition = decideMonitorTransition({
      monitor,
      now,
      observation,
      state: snapshot.state,
    });
    if (transition.kind === "none") return undefined;
    const committed = await dependencies.monitors.commitTransition({
      delivery: {
        email:
          monitor.data.notify.emailRoles.length > 0 ||
          monitor.data.notify.emailPrincipalIds.length > 0,
        webhooks: monitor.data.notify.webhooks,
      },
      now,
      observation,
      snapshot,
      transition,
    });
    if (committed !== "conflict") return committed;
  }
  return undefined;
}

/**
 * Routes one semantic event to every monitor of its tenancy that listens for it. Counting kinds
 * first store a signal keyed by the event (so a redelivered event is counted once) for every
 * matching monitor, then each matching monitor is evaluated on its own, so one that fails neither
 * drops another's signal nor skips its evaluation. Failures are rethrown together at the end so
 * the event is retried; the retry finds the finished work done.
 */
export async function evaluateMonitorsForEvent(
  dependencies: MonitorEvaluationDependencies,
  event: SemanticEvent,
): Promise<readonly CommittedTransition[]> {
  const organizationId = event.organizationId as Ulid;
  if (
    event.eventType === "budget.threshold-crossed" ||
    event.eventType === "organization.operator-funded-spend-exhausted"
  ) {
    await dependencies.monitors.ensureDefaultMonitors(organizationId);
  }
  // Eventually consistent: each evaluation re-reads its monitor and commits on a version guard.
  const monitors = (await dependencies.monitors.list(organizationId, "eventual")).filter(
    (monitor) =>
      monitor.data.status !== "archived" &&
      (monitor.data.environmentId === undefined ||
        monitor.data.environmentId === event.environmentId),
  );
  const failures: unknown[] = [];
  const targets: { readonly monitor: MonitorRecord; readonly oneShot?: MonitorObservation }[] = [];
  for (const monitor of monitors) {
    const match = matchMonitorEvent(monitor.data.condition, event);
    if (!match) continue;
    const source = MONITOR_KINDS[monitor.data.condition.kind].source.type;
    if (match.type === "signal" && source === "window-count") {
      try {
        await dependencies.monitors.recordSignal({
          activeUntil: match.activeUntil,
          eventId: event.eventId as Ulid,
          eventType: event.eventType,
          monitor,
          occurredAt: event.occurredAt,
        });
      } catch (cause) {
        failures.push(cause);
        continue;
      }
      targets.push({ monitor });
    } else if (match.type === "signal" && source === "one-shot") {
      if (Date.parse(match.activeUntil) <= dependencies.now().getTime()) continue;
      targets.push({
        monitor,
        oneShot: {
          escalation: true,
          eventId: event.eventId,
          firing: true,
          summary: match.summary ?? MONITOR_KINDS[monitor.data.condition.kind].label,
          until: match.activeUntil,
        },
      });
    } else {
      targets.push({ monitor });
    }
  }
  const results: CommittedTransition[] = [];
  for (const { monitor, oneShot } of targets) {
    try {
      const committed = await evaluateMonitor(
        dependencies,
        { monitorId: monitor.data.id, organizationId },
        { kind: "event", ...(oneShot ? { oneShot } : {}) },
      );
      if (committed) results.push(committed);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} monitor evaluations failed.`);
  }
  return results;
}
