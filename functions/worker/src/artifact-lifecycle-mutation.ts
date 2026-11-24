import {
  RuntimeToolPreparationRetryableError,
  type AgentRunExecutionPins,
} from "@deployments-ai/agent-runtime";
import {
  ArtifactRecord,
  executionEventPayload,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type DynamoValue,
  type PlatformRecord,
  type Ulid,
  workerPersistence,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { isDeepStrictEqual } from "node:util";

type Artifact = Extract<PlatformRecord, { readonly itemType: "artifact" }>;

export interface ArtifactMutationOptions {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
}

/**
 * Replaces an artifact and records its lifecycle event. `pins` are the acting run's execution
 * pins, so artifact changes made by preview and evaluation runs stay internal.
 */
export async function replaceArtifact(
  options: ArtifactMutationOptions,
  previous: Artifact,
  data: Artifact["data"],
  eventType: string,
  payload: Readonly<Record<string, DynamoValue>>,
  pins: AgentRunExecutionPins,
) {
  const next = Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data,
      itemType: "artifact" as const,
      ...(previous.ttl !== undefined ? { ttl: previous.ttl } : {}),
    }),
  );
  let event: ReturnType<typeof makeSemanticEventRecord> | undefined;
  if (next.data.visibility !== "private") {
    let priorEvents;
    let eventId: Ulid;
    try {
      [priorEvents, eventId] = await Promise.all([
        workerPersistence.find(options.database, "events", {
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": key("ORG", next.data.organizationId, "AGGREGATE", "artifact", next.data.id),
            ":sk": "SEMANTIC-EVENT#",
          },
          ConsistentRead: true,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
          Limit: 1,
          ScanIndexForward: false,
        }),
        options.generateId(),
      ]);
    } catch (cause) {
      throw new RuntimeToolPreparationRetryableError(eventType, cause);
    }
    const priorVersion = priorEvents.items.reduce(
      (maximum, record) =>
        record.itemType === "semantic-event" &&
        record.data.aggregateType === "artifact" &&
        record.data.aggregateId === next.data.id &&
        record.data.organizationId === next.data.organizationId
          ? Math.max(maximum, record.data.aggregateVersion)
          : maximum,
      0,
    );
    event = makeSemanticEventRecord({
      aggregateId: next.data.id,
      aggregateType: "artifact",
      aggregateVersion: priorVersion + 1,
      environmentId: next.data.environmentId,
      eventId,
      eventType,
      occurredAt: next.data.updatedAt,
      organizationId: next.data.organizationId,
      payload: executionEventPayload(pins, payload),
      projectId: next.data.projectId,
    });
  }
  try {
    await transactWithSemanticEvents(
      options.database,
      [{ kind: "put", previousRecord: previous, record: next }],
      event ? [event] : [],
    );
  } catch (cause) {
    let observed: PlatformRecord | undefined;
    try {
      observed = await workerPersistence.read(
        options.database,
        "execution",
        { pk: previous.pk, sk: previous.sk },
        true,
      );
    } catch (reconciliationCause) {
      throw new AggregateError(
        [cause, reconciliationCause],
        `Artifact ${eventType} transaction outcome could not be reconciled.`,
      );
    }
    if (observed?.itemType === "artifact" && isDeepStrictEqual(observed, next)) return observed;
    throw new RuntimeToolPreparationRetryableError(eventType, cause);
  }
  return next;
}
