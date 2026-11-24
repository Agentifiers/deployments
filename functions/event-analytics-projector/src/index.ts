import { FirehoseClient, PutRecordCommand, type PutRecordOutput } from "@aws-sdk/client-firehose";
import { parseSemanticEvent } from "@deployments-ai/events";

const DELIVERY_STREAM_NAME_ENV = "DEPLOYMENTS_AI_EVENT_ANALYTICS_STREAM_NAME";
const MAX_FIREHOSE_RECORD_BYTES = 1_024_000;

export interface SemanticEventBridgeEnvelope {
  readonly account: string;
  readonly detail: unknown;
  readonly "detail-type": string;
  readonly id: string;
  readonly region: string;
  readonly source: string;
  readonly time: string;
}

export interface FirehoseSender {
  readonly send: (command: PutRecordCommand) => Promise<PutRecordOutput>;
}

export interface EventAnalyticsProjectorDependencies {
  readonly deliveryStreamName?: string;
  readonly firehose?: FirehoseSender;
}

export interface SemanticEventAnalyticsRecord {
  readonly actor_id: string | null;
  readonly actor_type: string | null;
  readonly aggregate_id: string;
  readonly aggregate_type: string;
  readonly aggregate_version: number;
  readonly aws_account_id: string;
  readonly aws_region: string;
  readonly environment_id: string | null;
  readonly event_action: string | null;
  readonly event_entity: string | null;
  readonly event_id: string;
  readonly event_source: string;
  readonly event_type: string;
  readonly eventbridge_detail_type: string;
  readonly eventbridge_event_id: string;
  readonly ingested_at: string;
  readonly occurred_at: string;
  readonly organization_id: string;
  readonly payload_json: string;
  readonly project_id: string | null;
  readonly trace_id: string | null;
}

let firehoseClient: FirehoseClient | undefined;

function client() {
  firehoseClient ??= new FirehoseClient({});
  return firehoseClient;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function canonicalTimestamp(value: unknown, name: string) {
  const timestamp = requiredString(value, name);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new Error(`${name} must be an RFC3339 timestamp.`);
  return new Date(milliseconds).toISOString();
}

function deliveryStreamName(dependencies: EventAnalyticsProjectorDependencies) {
  const name = dependencies.deliveryStreamName ?? process.env[DELIVERY_STREAM_NAME_ENV];
  if (!name?.trim()) throw new Error(`${DELIVERY_STREAM_NAME_ENV} is required.`);
  return name;
}

function topicParts(eventType: string) {
  const separator = eventType.lastIndexOf(".");
  if (separator <= 0 || separator === eventType.length - 1) {
    return { eventAction: null, eventEntity: null };
  }
  return {
    eventAction: eventType.slice(separator + 1),
    eventEntity: eventType.slice(0, separator),
  };
}

export function semanticEventAnalyticsRecord(
  envelope: SemanticEventBridgeEnvelope,
): SemanticEventAnalyticsRecord {
  const detail = parseSemanticEvent(envelope.detail);
  const source = requiredString(envelope.source, "source");
  const detailType = requiredString(envelope["detail-type"], "detail-type");
  if (detailType !== detail.eventType) {
    throw new Error("detail-type must match detail.eventType.");
  }
  const topic = topicParts(detail.eventType);
  return {
    actor_id: detail.actor?.id ?? null,
    actor_type: detail.actor?.type ?? null,
    aggregate_id: detail.aggregateId,
    aggregate_type: detail.aggregateType,
    aggregate_version: detail.aggregateVersion,
    aws_account_id: requiredString(envelope.account, "account"),
    aws_region: requiredString(envelope.region, "region"),
    environment_id: detail.environmentId ?? null,
    event_action: topic.eventAction,
    event_entity: topic.eventEntity,
    event_id: detail.eventId,
    event_source: source,
    event_type: detail.eventType,
    eventbridge_detail_type: detailType,
    eventbridge_event_id: requiredString(envelope.id, "id"),
    ingested_at: canonicalTimestamp(envelope.time, "time"),
    occurred_at: detail.occurredAt,
    organization_id: detail.organizationId,
    payload_json: JSON.stringify(detail.payload),
    project_id: detail.projectId ?? null,
    trace_id: detail.traceId ?? null,
  };
}

function errorTag(cause: unknown) {
  if (cause && typeof cause === "object") {
    const tagged = cause as { readonly _tag?: unknown; readonly name?: unknown };
    if (typeof tagged._tag === "string") return tagged._tag;
    if (typeof tagged.name === "string") return tagged.name;
  }
  return "UnknownError";
}

export async function projectSemanticEvent(
  envelope: SemanticEventBridgeEnvelope,
  dependencies: EventAnalyticsProjectorDependencies = {},
) {
  try {
    const record = semanticEventAnalyticsRecord(envelope);
    const data = Buffer.from(`${JSON.stringify(record)}\n`);
    if (data.byteLength > MAX_FIREHOSE_RECORD_BYTES) {
      throw new Error("Semantic event analytical projection exceeds the Firehose record limit.");
    }
    const sender = dependencies.firehose ?? client();
    await sender.send(
      new PutRecordCommand({
        DeliveryStreamName: deliveryStreamName(dependencies),
        Record: { Data: data },
      }),
    );
    return { eventId: record.event_id };
  } catch (cause) {
    console.error("Failed to project a semantic event into the analytical event log.", {
      errorTag: errorTag(cause),
      eventbridgeEventId: typeof envelope.id === "string" ? envelope.id : undefined,
    });
    throw new Error("Semantic event analytical projection failed.");
  }
}

export const handler = projectSemanticEvent;
