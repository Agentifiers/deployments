import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import {
  MonitorIncidentRecord,
  MonitorStateRecord,
  type MonitorIncidentTimelineEntry,
} from "../records/monitors.ts";
import { transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { alertEvent } from "./events.ts";
import type { CommittedTransition, CommitTransitionInput } from "./persistence.ts";
import { incidentKey, scopeOf } from "./persistence.ts";
import type { MonitorObservation } from "./state-machine.ts";

type Incident = MonitorIncidentRecord;

const MAX_TIMELINE_ENTRIES = 50;

const decode = {
  incident: Schema.decodeUnknownSync(MonitorIncidentRecord),
  state: Schema.decodeUnknownSync(MonitorStateRecord),
};

interface CommitDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Ulid;
  readonly read: (
    table: "control" | "events",
    recordKey: { pk: string; sk: string },
  ) => Promise<PlatformRecord | undefined>;
}

function timelineEntry(
  type: MonitorIncidentTimelineEntry["type"],
  at: string,
  observation: MonitorObservation,
  notified: boolean,
): MonitorIncidentTimelineEntry {
  if (!observation.firing) {
    return { at, notified, summary: "The condition cleared.", type };
  }
  return {
    at,
    notified,
    summary: observation.summary,
    type,
    ...(observation.value === undefined ? {} : { value: observation.value }),
  };
}

const RESOLUTION_SUMMARY = {
  "condition-cleared": "The condition cleared.",
  "monitor-archived": "The monitor was archived.",
} as const;

/**
 * Commits one decided transition: the incident, the monitor state at the version the decision read,
 * and the alert semantic event in one transaction. A lost race returns `conflict` so the caller
 * re-reads and re-decides.
 */
export async function commitMonitorTransition(
  dependencies: CommitDependencies,
  { delivery, now: at, observation, previousMonitor, snapshot, transition }: CommitTransitionInput,
): Promise<CommittedTransition | "conflict"> {
  const { database, generateId, read } = dependencies;
  const { monitor, state } = snapshot;
  const timestamp = at.toISOString();
  const notified = transition.kind === "renotify" || transition.notify;
  const operations: TransactionOperation[] = previousMonitor
    ? [{ kind: "put", previousRecord: previousMonitor, record: monitor }]
    : [];
  let incident: Incident;
  let eventType: "alert.fired" | "alert.renotified" | "alert.resolved";
  let nextState: Record<string, unknown>;
  const applied =
    observation.firing && observation.eventId
      ? [...(state?.data.appliedEventIds ?? []), observation.eventId].slice(-20)
      : state?.data.appliedEventIds;
  const baseState = {
    ...(applied && applied.length > 0 ? { appliedEventIds: applied } : {}),
    createdAt: state?.data.createdAt ?? timestamp,
    ...scopeOf(monitor),
    monitorId: monitor.data.id,
    organizationId: monitor.data.organizationId,
    updatedAt: timestamp,
    version: (state?.data.version ?? 0) + 1,
  };
  if (transition.kind === "fire") {
    if (!observation.firing) throw new TypeError("A monitor fires only on a firing observation.");
    const incidentId = generateId();
    incident = decode.incident(
      withCanonicalRecordKeys({
        data: {
          createdAt: timestamp,
          ...scopeOf(monitor),
          id: incidentId,
          kind: monitor.data.condition.kind,
          monitorId: monitor.data.id,
          monitorName: monitor.data.name,
          openedAt: timestamp,
          organizationId: monitor.data.organizationId,
          status: "firing",
          summary: observation.summary,
          timeline: [timelineEntry("fired", timestamp, observation, notified)],
          updatedAt: timestamp,
          version: 1,
        },
        itemType: "monitor-incident" as const,
      }),
    );
    operations.push({ kind: "put", record: incident });
    eventType = "alert.fired";
    nextState = {
      ...baseState,
      firingSince: timestamp,
      ...(observation.until ? { firingUntil: observation.until } : {}),
      incidentId,
      ...(notified ? { lastNotifiedAt: timestamp } : {}),
      phase: "firing",
    };
  } else {
    const incidentId = state?.data.incidentId;
    if (!state || state.data.phase !== "firing" || !incidentId) {
      throw new TypeError("Only a firing monitor repeats or resolves its incident.");
    }
    const previous = await read(
      "events",
      incidentKey(monitor.data.organizationId, monitor.data.id, incidentId),
    );
    if (previous?.itemType !== "monitor-incident") return "conflict";
    const entry =
      transition.kind === "resolve"
        ? {
            at: timestamp,
            notified,
            summary: RESOLUTION_SUMMARY[transition.resolution],
            type: "resolved" as const,
          }
        : timelineEntry("renotified", timestamp, observation, notified);
    const timeline = [...previous.data.timeline, entry];
    if (timeline.length > MAX_TIMELINE_ENTRIES)
      timeline.splice(1, timeline.length - MAX_TIMELINE_ENTRIES);
    incident = decode.incident(
      withCanonicalRecordKeys({
        data: {
          ...previous.data,
          ...(transition.kind === "resolve"
            ? { resolution: transition.resolution, resolvedAt: timestamp, status: "resolved" }
            : {}),
          ...(observation.firing && transition.kind === "renotify"
            ? { summary: observation.summary }
            : {}),
          timeline,
          updatedAt: timestamp,
          version: previous.data.version + 1,
        },
        itemType: "monitor-incident" as const,
      }),
    );
    operations.push({ kind: "put", previousRecord: previous, record: incident });
    if (transition.kind === "resolve") {
      eventType = "alert.resolved";
      nextState = { ...baseState, phase: "ok" };
    } else {
      eventType = "alert.renotified";
      const { firingUntil, ...retained } = state.data;
      const until = observation.firing ? (observation.until ?? firingUntil) : firingUntil;
      nextState = {
        ...retained,
        ...baseState,
        ...(until ? { firingUntil: until } : {}),
        lastNotifiedAt: timestamp,
      };
    }
  }
  const stateRecord = decode.state(
    withCanonicalRecordKeys({ data: nextState, itemType: "monitor-state" as const }),
  );
  operations.push(
    state
      ? { kind: "put", previousRecord: state, record: stateRecord }
      : { kind: "put", record: stateRecord },
  );
  const eventId = generateId();
  const event = alertEvent({
    delivery: notified ? delivery : { email: false, webhooks: false },
    eventId,
    eventType,
    incident,
    monitor,
    occurredAt: timestamp,
  });
  try {
    await transactWithSemanticEvents(database, operations, [event]);
  } catch (cause) {
    if (isDatabaseWriteConflict(cause)) return "conflict";
    throw cause;
  }
  return { eventId, incident, transition };
}
