import type { MonitorRecord, MonitorStateRecord } from "../records/monitors.ts";

/** What one evaluation saw. `firing` observations carry what an email and the timeline show. */
export type MonitorObservation =
  | { readonly firing: false }
  | {
      readonly firing: true;
      readonly summary: string;
      readonly value?: number;
      /** A one-time signal keeps the incident open until this time, then it resolves itself. */
      readonly until?: string;
      /** New information arrived since the last notification (another budget threshold). */
      readonly escalation?: boolean;
      /** The one-time event this observation came from. */
      readonly eventId?: string;
    };

export type MonitorResolution = "condition-cleared" | "monitor-archived";

/** The single change an evaluation commits, or none. */
export type MonitorTransition =
  | { readonly kind: "none" }
  | { readonly kind: "fire"; readonly notify: boolean }
  | { readonly kind: "renotify"; readonly reason: "escalation" | "interval" }
  | {
      readonly kind: "resolve";
      /** Tell people it cleared: someone heard it fire, and the monitor is not muted now. */
      readonly notify: boolean;
      readonly resolution: MonitorResolution;
    };

/** Whether the monitor may tell anyone right now: active, or muted only until a past time. */
export function monitorNotifies(monitor: MonitorRecord, now: Date) {
  if (monitor.data.status === "active") return true;
  if (monitor.data.status !== "muted" || monitor.data.mutedUntil === undefined) return false;
  return Date.parse(monitor.data.mutedUntil) <= now.getTime();
}

/** Whether the monitor's repeat interval has passed since it last told anyone. */
export function renotifyDue(monitor: MonitorRecord, state: MonitorStateRecord, now: Date) {
  const minutes = monitor.data.renotifyMinutes;
  const last = state.data.lastNotifiedAt ?? state.data.firingSince;
  return (
    minutes !== undefined &&
    last !== undefined &&
    now.getTime() - Date.parse(last) >= minutes * 60_000
  );
}

/**
 * The monitor state machine. `ok` opens an incident when the condition holds; `firing` resolves
 * it when the condition clears, repeats the notification on the monitor's interval or on new
 * information, and otherwise does nothing, so one incident sends one notification and one
 * all-clear. A muted monitor still opens and resolves incidents but tells nobody; archiving
 * resolves silently, since the person who archived it already knows.
 */
export function decideMonitorTransition(input: {
  readonly monitor: MonitorRecord;
  readonly now: Date;
  readonly observation: MonitorObservation;
  readonly state: MonitorStateRecord | undefined;
}): MonitorTransition {
  const { monitor, now, observation, state } = input;
  const firing = state?.data.phase === "firing";
  if (
    observation.firing &&
    observation.eventId !== undefined &&
    state?.data.appliedEventIds?.includes(observation.eventId as never)
  ) {
    return { kind: "none" };
  }
  if (monitor.data.status === "archived") {
    return firing
      ? { kind: "resolve", notify: false, resolution: "monitor-archived" }
      : { kind: "none" };
  }
  if (!firing) {
    return observation.firing
      ? { kind: "fire", notify: monitorNotifies(monitor, now) }
      : { kind: "none" };
  }
  if (!observation.firing) {
    return {
      kind: "resolve",
      notify: state.data.lastNotifiedAt !== undefined && monitorNotifies(monitor, now),
      resolution: "condition-cleared",
    };
  }
  if (!monitorNotifies(monitor, now)) return { kind: "none" };
  if (observation.escalation) return { kind: "renotify", reason: "escalation" };
  return renotifyDue(monitor, state, now)
    ? { kind: "renotify", reason: "interval" }
    : { kind: "none" };
}
