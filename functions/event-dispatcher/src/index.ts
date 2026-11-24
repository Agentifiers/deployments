import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsResponse,
} from "@aws-sdk/client-eventbridge";
import {
  MAX_EVENTBRIDGE_BATCH_SIZE,
  semanticEventBridgeEntry,
  semanticEventIsInternal,
  semanticEventRecordFromStreamRecord,
  type DynamoStreamRecordLike,
  type SemanticEventBridgeEntry,
} from "@deployments-ai/events";
import { Effect } from "effect";

const EVENT_BUS_NAME_ENV = "DEPLOYMENTS_AI_EVENT_BUS_NAME";
const MAX_EVENTBRIDGE_REQUEST_BYTES = 1_048_576;

export interface DynamoStreamEventLike {
  readonly Records: readonly DynamoStreamRecordLike[];
}

export interface PartialBatchFailureResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

export interface EventBridgeSender {
  readonly send: (command: PutEventsCommand) => Promise<PutEventsResponse>;
}

export interface EventDispatcherDependencies {
  readonly eventBridge?: EventBridgeSender;
  readonly eventBusName?: string;
}

interface DispatchEntry {
  readonly entry: SemanticEventBridgeEntry;
  readonly itemIdentifier: string;
}

let eventBridgeClient: EventBridgeClient | undefined;

function client() {
  eventBridgeClient ??= new EventBridgeClient({});
  return eventBridgeClient;
}

function eventBridgeEntryBytes(entry: SemanticEventBridgeEntry) {
  const encoder = new TextEncoder();
  return (
    encoder.encode(entry.Source).byteLength +
    encoder.encode(entry.DetailType).byteLength +
    encoder.encode(entry.Detail).byteLength
  );
}

function eventBridgeBatches(values: readonly DispatchEntry[]) {
  const batches: DispatchEntry[][] = [];
  const oversized: DispatchEntry[] = [];
  let batch: DispatchEntry[] = [];
  let batchBytes = 0;

  for (const value of values) {
    const valueBytes = eventBridgeEntryBytes(value.entry);
    if (valueBytes >= MAX_EVENTBRIDGE_REQUEST_BYTES) {
      oversized.push(value);
      continue;
    }

    if (
      batch.length >= MAX_EVENTBRIDGE_BATCH_SIZE ||
      batchBytes + valueBytes >= MAX_EVENTBRIDGE_REQUEST_BYTES
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }

    batch.push(value);
    batchBytes += valueBytes;
  }

  if (batch.length > 0) batches.push(batch);
  return { batches, oversized };
}

function eventBusName(dependencies: EventDispatcherDependencies) {
  const name = dependencies.eventBusName ?? process.env[EVENT_BUS_NAME_ENV];
  if (!name?.trim()) {
    throw new Error(`${EVENT_BUS_NAME_ENV} is required to dispatch semantic events.`);
  }
  return name;
}

function recordIdentifier(record: DynamoStreamRecordLike, index: number) {
  return record.dynamodb?.SequenceNumber?.trim() || record.eventID?.trim() || `record-${index}`;
}

function errorTag(cause: unknown) {
  if (cause && typeof cause === "object") {
    const tagged = cause as { readonly _tag?: unknown; readonly name?: unknown };
    if (typeof tagged._tag === "string") return tagged._tag;
    if (typeof tagged.name === "string") return tagged.name;
  }
  return "UnknownError";
}

async function decodeDispatchEntries(records: readonly DynamoStreamRecordLike[], busName: string) {
  const entries: DispatchEntry[] = [];
  const failures: { itemIdentifier: string }[] = [];

  for (const [index, record] of records.entries()) {
    const itemIdentifier = recordIdentifier(record, index);
    try {
      const event = await Effect.runPromise(semanticEventRecordFromStreamRecord(record));
      if (!event || semanticEventIsInternal(event)) continue;
      entries.push({
        entry: semanticEventBridgeEntry(event, busName),
        itemIdentifier,
      });
    } catch (cause) {
      console.error("Failed to decode semantic event stream record.", {
        errorTag: errorTag(cause),
        itemIdentifier,
      });
      failures.push({ itemIdentifier });
    }
  }

  return { entries, failures };
}

async function publishBatch(sender: EventBridgeSender, batch: readonly DispatchEntry[]) {
  try {
    const response = await sender.send(
      new PutEventsCommand({
        Entries: batch.map(({ entry }) => entry),
      }),
    );

    return batch.flatMap(({ itemIdentifier }, index) => {
      const result = response.Entries?.[index];
      if (!result?.ErrorCode && !result?.ErrorMessage) return [];
      console.error("EventBridge rejected a semantic event.", {
        errorCode: result.ErrorCode,
        errorMessage: result.ErrorMessage,
        itemIdentifier,
      });
      return [{ itemIdentifier }];
    });
  } catch (cause) {
    console.error("Failed to dispatch semantic events to EventBridge.", {
      errorTag: errorTag(cause),
    });
    return batch.map(({ itemIdentifier }) => ({ itemIdentifier }));
  }
}

export async function handleSemanticEventStream(
  event: DynamoStreamEventLike,
  dependencies: EventDispatcherDependencies = {},
): Promise<PartialBatchFailureResponse> {
  if (event.Records.length === 0) return { batchItemFailures: [] };

  const busName = eventBusName(dependencies);
  const sender = dependencies.eventBridge ?? client();
  const decoded = await decodeDispatchEntries(event.Records, busName);
  const dispatch = eventBridgeBatches(decoded.entries);
  const publishFailures: { itemIdentifier: string }[] = [];
  for (const oversized of dispatch.oversized) {
    console.error("Semantic event exceeds the EventBridge PutEvents entry size limit.", {
      itemIdentifier: oversized.itemIdentifier,
    });
    publishFailures.push({ itemIdentifier: oversized.itemIdentifier });
  }
  for (const batch of dispatch.batches) {
    publishFailures.push(...(await publishBatch(sender, batch)));
  }

  return {
    batchItemFailures: [...decoded.failures, ...publishFailures],
  };
}

export const handler = handleSemanticEventStream;
