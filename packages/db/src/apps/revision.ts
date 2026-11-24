import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import type { ActorReference, DynamoValue } from "../record-schema.ts";
import { AppRecord } from "../records/apps.ts";
import type { SemanticEventRecord } from "../records/events.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  makeSemanticEventRecord,
  transactWithSemanticEvents,
  transactWithSemanticEventsForErasure,
} from "../semantic-event-storage.ts";
import { commit, refuse } from "./errors.ts";
import { APP_CHANGE_STATES, type AppChange } from "./lifecycle.ts";

export type AppActor = typeof ActorReference.Type;
export type AppErasureOwner = Parameters<
  NonNullable<DynamoDatabaseService["transactWriteForErasure"]>
>[1];
export type AppData = AppRecord["data"];
export type EventPayload = Readonly<Record<string, DynamoValue>>;

export interface AppRevisionDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Ulid;
  readonly now: () => Date;
}

export interface AppRevision {
  readonly actor: AppActor;
  readonly app: AppRecord;
  readonly changes: Partial<
    Pick<
      AppData,
      | "access"
      | "agentDefinitionId"
      | "databaseConvergenceStartedAt"
      | "databaseLayout"
      | "lifecycle"
      | "name"
      | "publication"
    >
  >;
  readonly companions?: readonly TransactionOperation[];
  readonly erasureOwner?: AppErasureOwner;
  readonly eventType: string;
  readonly operation: string;
  readonly payload: EventPayload;
  readonly updatedAt?: string;
}

export interface AppRevisions {
  readonly appEvent: (
    app: AppData,
    eventType: string,
    actor: AppActor,
    payload: EventPayload,
  ) => typeof SemanticEventRecord.Type;
  readonly reviseApp: (input: AppRevision) => Promise<AppRecord>;
  readonly transact: (
    operations: readonly TransactionOperation[],
    events: readonly (typeof SemanticEventRecord.Type)[],
    erasureOwner: AppErasureOwner | undefined,
  ) => Promise<void>;
}

const decodeApp = Schema.decodeUnknownSync(AppRecord);

export function appRecord(data: Omit<AppData, "status">) {
  return decodeApp(
    withCanonicalRecordKeys({
      data: { ...data, status: data.lifecycle.state },
      itemType: "app" as const,
    }),
  );
}

export function requireChange(operation: string, app: AppRecord, change: AppChange) {
  const allowed = APP_CHANGE_STATES[change];
  if (!allowed.includes(app.data.lifecycle.state)) {
    refuse(
      operation,
      "illegal-state",
      `App ${app.data.id} is ${app.data.lifecycle.state}; ${operation} needs ${allowed.join(" or ")}.`,
    );
  }
}

export function makeAppRevisions({
  database,
  generateId,
  now,
}: AppRevisionDependencies): AppRevisions {
  function appEvent(app: AppData, eventType: string, actor: AppActor, payload: EventPayload) {
    return makeSemanticEventRecord({
      actor,
      aggregateId: app.id,
      aggregateType: "app",
      aggregateVersion: app.version,
      environmentId: app.environmentId,
      eventId: generateId(),
      eventType,
      occurredAt: app.updatedAt,
      organizationId: app.organizationId,
      payload: { appId: app.id, ...payload },
      projectId: app.projectId,
    });
  }

  function transact(
    operations: readonly TransactionOperation[],
    events: readonly (typeof SemanticEventRecord.Type)[],
    erasureOwner: AppErasureOwner | undefined,
  ) {
    return erasureOwner
      ? transactWithSemanticEventsForErasure(database, operations, events, erasureOwner)
      : transactWithSemanticEvents(database, operations, events);
  }

  async function reviseApp(input: AppRevision) {
    const next = appRecord({
      ...input.app.data,
      ...input.changes,
      updatedAt: input.updatedAt ?? now().toISOString(),
      version: input.app.data.version + 1,
    });
    await commit(
      input.operation,
      transact(
        [{ kind: "put", previousRecord: input.app, record: next }, ...(input.companions ?? [])],
        [appEvent(next.data, input.eventType, input.actor, input.payload)],
        input.erasureOwner,
      ),
    );
    return next;
  }

  return { appEvent, reviseApp, transact };
}
