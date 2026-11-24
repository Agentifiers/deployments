import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { deterministicUlid, makeIdGenerator, type Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import { MONITOR_SWEEP_SHARD_COUNT } from "../record-key-secondary.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import {
  MonitorIncidentRecord,
  MonitorRecord,
  MonitorSignalRecord,
  MonitorStateRecord,
  type MonitorCondition,
  type MonitorNotify,
} from "../records/monitors.ts";
import { transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { alertTestEvent, type AlertDelivery } from "./events.ts";
import { commitMonitorTransition } from "./transition-commit.ts";
import { DEFAULT_ORGANIZATION_MONITORS, MONITOR_KINDS, type MonitorScope } from "./kinds.ts";
import {
  decideMonitorTransition,
  type MonitorObservation,
  type MonitorTransition,
} from "./state-machine.ts";

type Monitor = MonitorRecord;
type MonitorState = MonitorStateRecord;
type Incident = MonitorIncidentRecord;

/** Live (active or muted) monitors one organization may hold. */
export const MAX_MONITORS_PER_ORGANIZATION = 200;
const MAX_SIGNALS_COUNTED = 1_000;
const MAX_ARCHIVE_ATTEMPTS = 5;

const decode = {
  monitor: Schema.decodeUnknownSync(MonitorRecord),
  signal: Schema.decodeUnknownSync(MonitorSignalRecord),
  state: Schema.decodeUnknownSync(MonitorStateRecord),
};

function invalid(message: string) {
  return new PersistenceError("invalid-input", "invalid_monitor", message);
}

function notFound() {
  return new PersistenceError("not-found", "monitor_not_found", "The monitor was not found.");
}

function decodeChecked<T>(decoder: (value: unknown) => T, value: unknown): T {
  try {
    return decoder(value);
  } catch (cause) {
    throw invalid(cause instanceof Error ? cause.message : "The monitor is invalid.");
  }
}

export function monitorKey(organizationId: Ulid, monitorId: Ulid) {
  return { pk: key("ORG", organizationId), sk: key("MONITOR", monitorId) };
}

function stateKey(organizationId: Ulid, monitorId: Ulid) {
  return { pk: key("ORG", organizationId), sk: key("MONITOR-STATE", monitorId) };
}

export function incidentKey(organizationId: Ulid, monitorId: Ulid, incidentId: Ulid) {
  return {
    pk: key("ORG", organizationId, "MONITOR", monitorId),
    sk: key("MONITOR-INCIDENT", incidentId),
  };
}

/** Deterministic, so concurrent first events of an organization create one default monitor. */
export function defaultMonitorId(organizationId: Ulid, kind: MonitorCondition["kind"]) {
  return deterministicUlid(`default-monitor:${organizationId}:${kind}`);
}

function scopeFields(scope: MonitorScope) {
  return scope.kind === "environment"
    ? { environmentId: scope.environmentId, projectId: scope.projectId }
    : {};
}

export function scopeOf(record: {
  readonly data: { readonly environmentId?: Ulid; readonly projectId?: Ulid };
}) {
  return record.data.environmentId && record.data.projectId
    ? { environmentId: record.data.environmentId, projectId: record.data.projectId }
    : {};
}

export interface CreateMonitorInput {
  readonly condition: MonitorCondition;
  readonly name: string;
  readonly notify: MonitorNotify;
  readonly organizationId: Ulid;
  readonly renotifyMinutes?: number;
  readonly scope: MonitorScope;
}

export interface UpdateMonitorInput {
  readonly condition?: MonitorCondition;
  readonly expectedVersion?: number;
  readonly monitorId: Ulid;
  readonly mute?: { readonly until?: string } | null;
  readonly name?: string;
  readonly notify?: MonitorNotify;
  readonly organizationId: Ulid;
  readonly renotifyMinutes?: number | null;
}

/** Everything an evaluation needs to read and the commit it decided. */
export interface MonitorSnapshot {
  readonly monitor: Monitor;
  readonly state: MonitorState | undefined;
}

export interface CommittedTransition {
  readonly eventId: Ulid;
  readonly incident: Incident;
  readonly transition: Exclude<MonitorTransition, { readonly kind: "none" }>;
}

export interface CommitTransitionInput {
  readonly delivery: AlertDelivery;
  readonly now: Date;
  readonly observation: MonitorObservation;
  /** The stored monitor `snapshot.monitor` replaces in the same transaction, when it changed. */
  readonly previousMonitor?: Monitor;
  readonly snapshot: MonitorSnapshot;
  readonly transition: Exclude<MonitorTransition, { readonly kind: "none" }>;
}

export interface MonitorPersistence {
  readonly archive: (organizationId: Ulid, monitorId: Ulid) => Promise<Monitor>;
  readonly commitTransition: (
    input: CommitTransitionInput,
  ) => Promise<CommittedTransition | "conflict">;
  readonly countSignals: (monitor: Monitor, since: Date) => Promise<number>;
  readonly create: (input: CreateMonitorInput) => Promise<Monitor>;
  readonly ensureDefaultMonitors: (organizationId: Ulid) => Promise<readonly Monitor[]>;
  readonly get: (organizationId: Ulid, monitorId: Ulid) => Promise<Monitor>;
  /** Strongly consistent unless `eventual`, for readers that re-read before they decide. */
  readonly list: (
    organizationId: Ulid,
    read?: "consistent" | "eventual",
  ) => Promise<readonly Monitor[]>;
  readonly recordSignal: (input: {
    readonly activeUntil: string;
    readonly eventId: Ulid;
    readonly eventType: string;
    readonly monitor: Monitor;
    readonly occurredAt: string;
  }) => Promise<void>;
  /** Emits one test alert for the monitor; email goes only to the member who asked. */
  readonly sendTest: (input: {
    readonly monitorId: Ulid;
    readonly organizationId: Ulid;
    readonly requestedByPrincipalId: Ulid;
  }) => Promise<{ readonly eventId: Ulid }>;
  readonly snapshot: (
    organizationId: Ulid,
    monitorId: Ulid,
  ) => Promise<MonitorSnapshot | undefined>;
  readonly sweepPage: (input: {
    readonly cursor?: Readonly<Record<string, unknown>>;
    readonly shard: number;
  }) => Promise<{
    readonly monitors: readonly { readonly monitorId: Ulid; readonly organizationId: Ulid }[];
    readonly cursor?: Readonly<Record<string, unknown>>;
  }>;
  readonly update: (input: UpdateMonitorInput) => Promise<Monitor>;
}

export interface MonitorPersistenceDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Ulid;
  readonly now?: () => Date;
}

/**
 * Monitor configuration, evaluation state, counting signals, incident history, and member
 * notification preferences. Every evaluation commit is one transaction guarded by the
 * `monitor-state` version, so evaluators that race or retry converge on one incident.
 */
export function makeMonitorPersistence(
  dependencies: MonitorPersistenceDependencies,
): MonitorPersistence {
  const { database } = dependencies;
  const ids = makeIdGenerator();
  const generateId = dependencies.generateId ?? (() => ids.generate());
  const now = dependencies.now ?? (() => new Date());

  async function read(table: "control" | "events", recordKey: { pk: string; sk: string }) {
    return database.getRecord(table, recordKey, true);
  }

  async function load(organizationId: Ulid, monitorId: Ulid): Promise<Monitor> {
    const record = await read("control", monitorKey(organizationId, monitorId));
    if (record?.itemType !== "monitor") throw notFound();
    return record;
  }

  async function loadState(organizationId: Ulid, monitorId: Ulid) {
    const record = await read("control", stateKey(organizationId, monitorId));
    return record?.itemType === "monitor-state" ? record : undefined;
  }

  async function list(
    organizationId: Ulid,
    consistency: "consistent" | "eventual" = "consistent",
  ): Promise<readonly Monitor[]> {
    const monitors: Monitor[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await database.queryRecords("control", {
        ConsistentRead: consistency === "consistent",
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        ExpressionAttributeNames: { "#partition": "pk", "#sort": "sk" },
        ExpressionAttributeValues: {
          ":partition": key("ORG", organizationId),
          ":prefix": `${key("MONITOR")}#`,
        },
        KeyConditionExpression: "#partition = :partition AND begins_with(#sort, :prefix)",
        Limit: 100,
      });
      for (const item of page.items) if (item.itemType === "monitor") monitors.push(item);
      cursor = page.lastEvaluatedKey;
    } while (cursor);
    return monitors;
  }

  function validate(condition: MonitorCondition, scope: MonitorScope) {
    if (MONITOR_KINDS[condition.kind].scope !== scope.kind) {
      throw invalid(
        `${MONITOR_KINDS[condition.kind].label} monitors watch ${
          MONITOR_KINDS[condition.kind].scope === "environment"
            ? "one environment"
            : "the whole organization"
        }.`,
      );
    }
  }

  function monitorName(value: string) {
    const name = value.trim();
    if (name.length === 0 || name.length > 120)
      throw invalid("Monitor names must be 1 to 120 characters.");
    return name;
  }

  /**
   * The limit bounds what members create. The default monitors are the platform's own spend
   * alerts, so they are created even in an organization already at the limit.
   */
  async function create(
    input: CreateMonitorInput,
    origin: { readonly kind: "member" } | { readonly id: Ulid; readonly kind: "default" } = {
      kind: "member",
    },
  ) {
    validate(input.condition, input.scope);
    const id = origin.kind === "default" ? origin.id : generateId();
    if (origin.kind === "member") {
      const live = (await list(input.organizationId)).filter(
        (monitor) => monitor.data.status !== "archived",
      );
      if (live.length >= MAX_MONITORS_PER_ORGANIZATION) {
        throw new PersistenceError(
          "conflict",
          "monitor_limit_exceeded",
          `An organization may hold at most ${MAX_MONITORS_PER_ORGANIZATION} monitors; archive one first.`,
        );
      }
    }
    const timestamp = now().toISOString();
    const monitor = decodeChecked(
      decode.monitor,
      withCanonicalRecordKeys({
        data: {
          condition: input.condition,
          createdAt: timestamp,
          ...scopeFields(input.scope),
          id,
          name: monitorName(input.name),
          notify: input.notify,
          organizationId: input.organizationId,
          ...(input.renotifyMinutes === undefined
            ? {}
            : { renotifyMinutes: input.renotifyMinutes }),
          status: "active",
          updatedAt: timestamp,
          version: 1,
        },
        itemType: "monitor" as const,
      }),
    );
    const state = decode.state(
      withCanonicalRecordKeys({
        data: {
          createdAt: timestamp,
          ...scopeFields(input.scope),
          monitorId: id,
          organizationId: input.organizationId,
          phase: "ok",
          updatedAt: timestamp,
          version: 1,
        },
        itemType: "monitor-state" as const,
      }),
    );
    try {
      await transactWithSemanticEvents(
        database,
        [
          { kind: "put", record: monitor },
          { kind: "put", record: state },
        ],
        [],
      );
    } catch (cause) {
      if (isDatabaseWriteConflict(cause)) {
        throw new PersistenceError("conflict", "monitor_exists", "The monitor already exists.");
      }
      throw cause;
    }
    return monitor;
  }

  function nextMonitor(previous: Monitor, data: Record<string, unknown>) {
    return decodeChecked(
      decode.monitor,
      withCanonicalRecordKeys({
        data: { ...data, updatedAt: now().toISOString(), version: previous.data.version + 1 },
        itemType: "monitor" as const,
      }),
    );
  }

  function monitorChanged() {
    return new PersistenceError(
      "conflict",
      "monitor_changed",
      "Someone changed this monitor at the same time. Reload it and try again.",
    );
  }

  async function replaceMonitor(previous: Monitor, data: Record<string, unknown>) {
    const next = nextMonitor(previous, data);
    try {
      await transactWithSemanticEvents(
        database,
        [{ kind: "put", previousRecord: previous, record: next }],
        [],
      );
    } catch (cause) {
      if (isDatabaseWriteConflict(cause)) throw monitorChanged();
      throw cause;
    }
    return next;
  }

  async function listSignals(monitor: Monitor, since: Date) {
    const page = await database.queryRecords("events", {
      ConsistentRead: true,
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":lower": key("MONITOR-SIGNAL", since.toISOString()),
        ":pk": key("ORG", monitor.data.organizationId, "MONITOR", monitor.data.id),
        ":upper": `${key("MONITOR-SIGNAL")}#~`,
      },
      KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :lower AND :upper",
      Limit: MAX_SIGNALS_COUNTED,
    });
    return page.items.filter(
      (item): item is Extract<PlatformRecord, { readonly itemType: "monitor-signal" }> =>
        item.itemType === "monitor-signal" && Date.parse(item.data.activeUntil) > now().getTime(),
    );
  }

  return {
    get: load,
    list,
    create: (input) => create(input),

    async ensureDefaultMonitors(organizationId) {
      const existing = await list(organizationId);
      const created: Monitor[] = [];
      for (const definition of DEFAULT_ORGANIZATION_MONITORS) {
        const id = defaultMonitorId(organizationId, definition.condition.kind);
        const found = existing.find((monitor) => monitor.data.id === id);
        if (found) {
          created.push(found);
          continue;
        }
        try {
          created.push(
            await create(
              { ...definition, organizationId, scope: { kind: "organization" } },
              { id, kind: "default" },
            ),
          );
        } catch (cause) {
          if (!(cause instanceof PersistenceError) || cause.code !== "monitor_exists") throw cause;
          created.push(await load(organizationId, id));
        }
      }
      return created;
    },

    async update(input) {
      const previous = await load(input.organizationId, input.monitorId);
      if (previous.data.status === "archived") {
        throw new PersistenceError(
          "conflict",
          "monitor_archived",
          "Archived monitors cannot change.",
        );
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== previous.data.version) {
        throw new PersistenceError(
          "conflict",
          "monitor_changed",
          "Someone changed this monitor after you opened it. Reload it to see the current values.",
        );
      }
      const condition = input.condition ?? previous.data.condition;
      if (condition.kind !== previous.data.condition.kind) {
        throw invalid("A monitor's kind cannot change; create a new monitor instead.");
      }
      const { mutedUntil, renotifyMinutes, ...retained } = previous.data;
      const muted =
        input.mute === undefined
          ? { status: retained.status, ...(mutedUntil ? { mutedUntil } : {}) }
          : input.mute === null
            ? { status: "active" as const }
            : {
                status: "muted" as const,
                ...(input.mute.until ? { mutedUntil: input.mute.until } : {}),
              };
      const nextRenotify =
        input.renotifyMinutes === undefined
          ? renotifyMinutes
          : (input.renotifyMinutes ?? undefined);
      return replaceMonitor(previous, {
        ...retained,
        ...muted,
        condition,
        ...(input.name === undefined ? {} : { name: monitorName(input.name) }),
        ...(input.notify === undefined ? {} : { notify: input.notify }),
        ...(nextRenotify === undefined ? {} : { renotifyMinutes: nextRenotify }),
      });
    },

    /**
     * Archives the monitor and, in the same transaction, silently resolves the incident it has
     * open, since archived monitors are never evaluated again. Archiving an archived monitor
     * resolves an incident a crash left open, so a retry converges.
     */
    async archive(organizationId, monitorId) {
      for (let attempt = 0; attempt < MAX_ARCHIVE_ATTEMPTS; attempt += 1) {
        const [previous, state] = await Promise.all([
          load(organizationId, monitorId),
          loadState(organizationId, monitorId),
        ]);
        const { mutedUntil: _mutedUntil, ...retained } = previous.data;
        const monitor =
          previous.data.status === "archived"
            ? previous
            : nextMonitor(previous, {
                ...retained,
                archivedAt: now().toISOString(),
                status: "archived",
              });
        const at = now();
        const observation = { firing: false } as const;
        const transition = decideMonitorTransition({ monitor, now: at, observation, state });
        if (transition.kind === "none") {
          if (monitor === previous) return previous;
          // Advancing the state version makes an evaluation that read the active monitor
          // conflict and re-read, so it cannot open an incident on the archived one.
          const touched = decode.state(
            withCanonicalRecordKeys({
              data: state
                ? { ...state.data, updatedAt: at.toISOString(), version: state.data.version + 1 }
                : {
                    createdAt: at.toISOString(),
                    ...scopeOf(previous),
                    monitorId,
                    organizationId,
                    phase: "ok",
                    updatedAt: at.toISOString(),
                    version: 1,
                  },
              itemType: "monitor-state" as const,
            }),
          );
          try {
            await transactWithSemanticEvents(
              database,
              [
                { kind: "put", previousRecord: previous, record: monitor },
                state
                  ? { kind: "put", previousRecord: state, record: touched }
                  : { kind: "put", record: touched },
              ],
              [],
            );
            return monitor;
          } catch (cause) {
            if (!isDatabaseWriteConflict(cause)) throw cause;
            continue;
          }
        }
        const committed = await commitMonitorTransition(
          { database, generateId, read },
          {
            delivery: { email: false, webhooks: false },
            now: at,
            observation,
            ...(monitor === previous ? {} : { previousMonitor: previous }),
            snapshot: { monitor, state },
            transition,
          },
        );
        if (committed !== "conflict") return monitor;
      }
      throw monitorChanged();
    },

    async sendTest({ monitorId, organizationId, requestedByPrincipalId }) {
      const monitor = await load(organizationId, monitorId);
      if (monitor.data.status === "archived") {
        throw new PersistenceError(
          "conflict",
          "monitor_archived",
          "Archived monitors cannot send.",
        );
      }
      const eventId = generateId();
      await transactWithSemanticEvents(
        database,
        [],
        [
          alertTestEvent({
            eventId,
            monitor,
            occurredAt: now().toISOString(),
            requestedByPrincipalId,
          }),
        ],
      );
      return { eventId };
    },

    async snapshot(organizationId, monitorId) {
      const [monitor, state] = await Promise.all([
        read("control", monitorKey(organizationId, monitorId)),
        loadState(organizationId, monitorId),
      ]);
      return monitor?.itemType === "monitor" ? { monitor, state } : undefined;
    },

    async recordSignal(input) {
      const signal = decode.signal(
        withCanonicalRecordKeys({
          data: {
            activeUntil: input.activeUntil,
            eventId: input.eventId,
            eventType: input.eventType,
            monitorId: input.monitor.data.id,
            occurredAt: input.occurredAt,
            organizationId: input.monitor.data.organizationId,
          },
          itemType: "monitor-signal" as const,
          ttl: Math.floor(Date.parse(input.activeUntil) / 1_000),
        }),
      );
      try {
        await database.transactWrite([{ kind: "put", record: signal }]);
      } catch (cause) {
        // The event was already counted: signals are keyed by the event that produced them.
        if (!isDatabaseWriteConflict(cause)) throw cause;
      }
    },

    async countSignals(monitor, since) {
      return (await listSignals(monitor, since)).length;
    },

    commitTransition: (input) => commitMonitorTransition({ database, generateId, read }, input),

    async sweepPage({ cursor, shard }) {
      if (!Number.isInteger(shard) || shard < 0 || shard >= MONITOR_SWEEP_SHARD_COUNT) {
        throw new RangeError("Monitor sweep shard is out of range.");
      }
      const page = await database.queryRecords("control", {
        ...(cursor ? { ExclusiveStartKey: { ...cursor } } : {}),
        ExpressionAttributeNames: { "#pk": "gsi1pk" },
        ExpressionAttributeValues: { ":pk": key("MONITOR-SWEEP", String(shard).padStart(2, "0")) },
        IndexName: "gsi1",
        KeyConditionExpression: "#pk = :pk",
        Limit: 100,
      });
      return {
        monitors: page.items.flatMap((item) =>
          item.itemType === "monitor"
            ? [{ monitorId: item.data.id, organizationId: item.data.organizationId }]
            : [],
        ),
        ...(page.lastEvaluatedKey ? { cursor: page.lastEvaluatedKey } : {}),
      };
    },
  };
}
