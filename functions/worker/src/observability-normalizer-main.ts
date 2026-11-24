/* eslint-disable no-await-in-loop -- Kinesis batches preserve source order across bounded requests. */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KinesisClient, PutRecordsCommand } from "@aws-sdk/client-kinesis";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  decodePlatformRecord,
  key,
  makeDynamoDatabase,
  tableNamesFromEnvironment,
  type PlatformRecord,
  workerPersistence,
} from "@deployments-ai/db";
import type { ObservabilityFact } from "@deployments-ai/observability";
import { Effect, Schema, type SchemaIssue } from "effect";
import { createHash } from "node:crypto";
import {
  observabilityFactsForTransition,
  type ObservabilityStreamTransition,
} from "./observability-normalizer.ts";
import {
  emitObservabilityErasedOrganizationFactsMetric,
  emitObservabilityFailedRecordsMetric,
} from "./observability-failure-metrics.ts";

const MAX_FACT_BYTES = 64 * 1024;
const MAX_KINESIS_BATCH_BYTES = 4_500_000;
const MAX_KINESIS_BATCH_RECORDS = 500;
const KINESIS_STREAM_ENV = "DEPLOYMENTS_AI_OBSERVABILITY_KINESIS_STREAM";
const QUARANTINE_BUCKET_ENV = "DEPLOYMENTS_AI_OBSERVABILITY_QUARANTINE_BUCKET";

export interface ObservabilityDynamoStreamRecord {
  readonly dynamodb?: {
    readonly NewImage?: Record<string, AttributeValue>;
    readonly OldImage?: Record<string, AttributeValue>;
    readonly SequenceNumber?: string;
  };
  readonly eventID?: string;
  readonly eventName?: string;
  readonly eventSourceARN?: string;
}

export interface ObservabilityDynamoStreamEvent {
  readonly Records?: readonly ObservabilityDynamoStreamRecord[];
}

export interface EncodedFact {
  readonly data: Uint8Array;
  readonly fact: ObservabilityFact;
  readonly partitionKey: string;
  readonly sourceIdentifier: string;
}

export interface ObservabilitySanitizedFailure {
  readonly code?: string;
  readonly fingerprint: string;
  readonly name: string;
}

export interface ObservabilityNormalizationFailure {
  readonly decodeIssues: readonly string[];
  readonly eventName: string;
  readonly failure: ObservabilitySanitizedFailure;
  readonly itemType?: string;
  readonly quarantineKey?: string;
  readonly sequenceNumber: string;
}

export interface ObservabilityNormalizerRuntimeDependencies {
  readonly now?: () => Date;
  /** Reports whether the organization's control-table row still exists (erased orgs have none). */
  readonly organizationExists: (organizationId: string) => Promise<boolean>;
  readonly quarantine: (
    record: ObservabilityDynamoStreamRecord,
    table: "execution" | "usage",
    cause: unknown,
  ) => Promise<"discard" | "retry">;
  readonly writeFacts: (facts: readonly EncodedFact[]) => Promise<readonly number[]>;
}

const kinesis = new KinesisClient({});
const s3 = new S3Client({});
const database = makeDynamoDatabase(
  DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }),
  tableNamesFromEnvironment(),
);

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function recordIdentifier(record: ObservabilityDynamoStreamRecord) {
  const identifier = record.dynamodb?.SequenceNumber?.trim();
  if (!identifier) throw new Error("Observability stream record has no sequence number.");
  return identifier;
}

async function decodeImage(image: Record<string, AttributeValue> | undefined) {
  return image ? await Effect.runPromise(decodePlatformRecord(unmarshall(image))) : undefined;
}

export function observabilityQuarantineKey(
  record: ObservabilityDynamoStreamRecord,
  table: "execution" | "usage",
) {
  const scope = observabilityQuarantineScope(record);
  const root = scope ? `organizations/${scope.organizationId}` : "unscoped";
  return `${root}/${table}/${observabilityQuarantineFingerprint(record)}.json`;
}

function observabilityQuarantineFingerprint(record: ObservabilityDynamoStreamRecord) {
  const sequence = recordIdentifier(record);
  const eventId = record.eventID?.trim();
  if (!eventId) throw new Error("Observability stream record has no event ID.");
  const streamArn = record.eventSourceARN?.trim() ?? "unknown-stream";
  return createHash("sha256").update(`${streamArn}\0${eventId}\0${sequence}`).digest("hex");
}

function boundedReason(value: unknown) {
  return typeof value === "string"
    ? value.replace(/[^a-zA-Z0-9._:-]/gu, "_").slice(0, 128)
    : undefined;
}

export function observabilityQuarantineFailure(cause: unknown): ObservabilitySanitizedFailure {
  const failure = cause !== null && typeof cause === "object" ? cause : undefined;
  const name = boundedReason((failure as { readonly name?: unknown } | undefined)?.name);
  const code = boundedReason((failure as { readonly code?: unknown } | undefined)?.code);
  return {
    ...(code ? { code } : {}),
    fingerprint: createHash("sha256").update(String(cause)).digest("hex"),
    name: name ?? "UnknownError",
  };
}

function observabilityQuarantineScope(record: ObservabilityDynamoStreamRecord) {
  for (const image of [record.dynamodb?.NewImage, record.dynamodb?.OldImage]) {
    const organizationId = image?.data?.M?.organizationId?.S?.trim();
    if (organizationId && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(organizationId)) {
      return { organizationId };
    }
  }
  return undefined;
}

function sourceEventName(record: ObservabilityDynamoStreamRecord) {
  return record.eventName === "INSERT" ||
    record.eventName === "MODIFY" ||
    record.eventName === "REMOVE"
    ? record.eventName
    : "UNKNOWN";
}

export function observabilityQuarantinePayload(
  record: ObservabilityDynamoStreamRecord,
  table: "execution" | "usage",
  cause: unknown,
) {
  const scope = observabilityQuarantineScope(record);
  return {
    failure: observabilityQuarantineFailure(cause),
    ...(scope ? { record } : {}),
    source: {
      eventName: sourceEventName(record),
      fingerprint: observabilityQuarantineFingerprint(record),
      table,
    },
  };
}

function decodeIssuePaths(
  issue: SchemaIssue.Issue,
  path: readonly PropertyKey[] = [],
): readonly string[] {
  switch (issue._tag) {
    case "Pointer":
      return decodeIssuePaths(issue.issue, [...path, ...issue.path]);
    case "AnyOf":
    case "Composite":
      return issue.issues.flatMap((child) => decodeIssuePaths(child, path));
    case "Encoding":
    case "Filter":
      return decodeIssuePaths(issue.issue, path);
    case "Forbidden":
    case "InvalidType":
    case "InvalidValue":
    case "MissingKey":
    case "OneOf":
    case "UnexpectedKey":
      // Keys below a record's own fields can be tenant-chosen map keys.
      return [`${path.slice(0, 2).map(String).join(".") || "<root>"}: ${issue._tag}`];
  }
}

function imageDecodeIssues(record: ObservabilityDynamoStreamRecord) {
  return (["NewImage", "OldImage"] as const).flatMap((image) => {
    const item = record.dynamodb?.[image];
    if (!item) return [];
    try {
      const error = Effect.runSync(
        Effect.match(decodePlatformRecord(unmarshall(item)), {
          onFailure: (failure) => failure,
          onSuccess: () => undefined,
        }),
      );
      if (!error) return [];
      return Schema.isSchemaError(error.cause)
        ? decodeIssuePaths(error.cause.issue).map((issue) => `${image} ${issue}`)
        : [`${image}: ${error.message}`];
    } catch {
      return [`${image}: unreadable`];
    }
  });
}

function normalizationFailure(
  record: ObservabilityDynamoStreamRecord,
  table: "execution" | "usage",
  cause: unknown,
  sequenceNumber: string,
): ObservabilityNormalizationFailure {
  const dynamodb = record.dynamodb;
  const itemType = boundedReason(
    dynamodb?.NewImage?.itemType?.S ?? dynamodb?.OldImage?.itemType?.S,
  );
  return {
    decodeIssues: imageDecodeIssues(record),
    eventName: sourceEventName(record),
    failure: observabilityQuarantineFailure(cause),
    ...(itemType ? { itemType } : {}),
    ...(record.eventID?.trim() ? { quarantineKey: observabilityQuarantineKey(record, table) } : {}),
    sequenceNumber,
  };
}

async function organizationExists(organizationId: string) {
  const organizationKey = {
    pk: key("ORG", organizationId),
    sk: key("ORG", organizationId),
  };
  const organization = await workerPersistence.read(database, "control", organizationKey, true);
  return organization !== undefined;
}

async function rawQuarantineAllowed(organizationId: string) {
  const fenceKey = {
    pk: key("ORG", organizationId),
    sk: key("ERASURE-FENCE", organizationId),
  };
  const [organization, fence] = await Promise.all([
    organizationExists(organizationId),
    workerPersistence.read(database, "control", fenceKey),
  ]);
  return organization && fence === undefined;
}

function encodedFact(fact: ObservabilityFact, sourceIdentifier: string): EncodedFact {
  const data = Buffer.from(`${JSON.stringify(fact)}\n`);
  if (data.byteLength > MAX_FACT_BYTES) {
    throw new Error(`Observability fact ${fact.factId} exceeds ${MAX_FACT_BYTES} bytes.`);
  }
  const traceKey = fact.trace?.traceId ?? fact.source.recordId;
  const partitionKey = `${fact.scope.organizationId}:${createHash("sha256")
    .update(traceKey)
    .digest("hex")
    .slice(0, 32)}`;
  return { data, fact, partitionKey, sourceIdentifier };
}

function isPreconditionFailure(cause: unknown) {
  return (
    cause !== null &&
    typeof cause === "object" &&
    (cause as { readonly $metadata?: { readonly httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === 412
  );
}

async function quarantine(
  record: ObservabilityDynamoStreamRecord,
  table: "execution" | "usage",
  cause: unknown,
) {
  const scope = observabilityQuarantineScope(record);
  if (!scope || !(await rawQuarantineAllowed(scope.organizationId))) return "discard";
  let uploadedVersionId: string | undefined;
  try {
    const uploaded = await s3.send(
      new PutObjectCommand({
        Body: JSON.stringify(observabilityQuarantinePayload(record, table, cause)),
        Bucket: requiredEnvironment(QUARANTINE_BUCKET_ENV),
        ContentType: "application/json",
        IfNoneMatch: "*",
        Key: observabilityQuarantineKey(record, table),
      }),
    );
    uploadedVersionId = uploaded.VersionId;
    if (scope && !uploadedVersionId) {
      throw new Error("Versioned observability quarantine storage returned no version ID.");
    }
  } catch (cause) {
    if (!isPreconditionFailure(cause)) throw cause;
  }
  if (!uploadedVersionId) return "retry";
  let allowed = false;
  try {
    allowed = await rawQuarantineAllowed(scope.organizationId);
  } catch (cause) {
    await s3
      .send(
        new DeleteObjectCommand({
          Bucket: requiredEnvironment(QUARANTINE_BUCKET_ENV),
          Key: observabilityQuarantineKey(record, table),
          VersionId: uploadedVersionId,
        }),
      )
      .catch(() => undefined);
    throw cause;
  }
  if (!allowed) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: requiredEnvironment(QUARANTINE_BUCKET_ENV),
        Key: observabilityQuarantineKey(record, table),
        VersionId: uploadedVersionId,
      }),
    );
    return "discard";
  }
  return "retry";
}

async function writeFacts(facts: readonly EncodedFact[]) {
  if (facts.length === 0) return [];
  const failedIndexes: number[] = [];
  let start = 0;
  while (start < facts.length) {
    let bytes = 0;
    let end = start;
    while (
      end < facts.length &&
      end - start < MAX_KINESIS_BATCH_RECORDS &&
      bytes + facts[end]!.data.byteLength <= MAX_KINESIS_BATCH_BYTES
    ) {
      bytes += facts[end]!.data.byteLength;
      end += 1;
    }
    const batch = facts.slice(start, end);
    const output = await kinesis.send(
      new PutRecordsCommand({
        Records: batch.map((fact) => ({ Data: fact.data, PartitionKey: fact.partitionKey })),
        StreamName: requiredEnvironment(KINESIS_STREAM_ENV),
      }),
    );
    failedIndexes.push(
      ...(output.Records ?? []).flatMap((result, index) =>
        result.ErrorCode || result.ErrorMessage ? [start + index] : [],
      ),
    );
    start = end;
  }
  return failedIndexes;
}

function runtimeDependencies(): ObservabilityNormalizerRuntimeDependencies {
  return {
    organizationExists,
    quarantine,
    writeFacts,
  };
}

function transitionFor(
  table: "execution" | "usage",
  record: ObservabilityDynamoStreamRecord,
  current: PlatformRecord | undefined,
  previous: PlatformRecord | undefined,
  normalizedAt: string,
): ObservabilityStreamTransition {
  const eventName = record.eventName;
  if (eventName !== "INSERT" && eventName !== "MODIFY" && eventName !== "REMOVE") {
    throw new Error("Observability source event name is invalid.");
  }
  const streamArn = record.eventSourceARN?.trim();
  if (!streamArn) throw new Error("Observability stream record has no source ARN.");
  return {
    ...(current ? { current } : {}),
    eventName,
    normalizedAt,
    ...(previous ? { previous } : {}),
    streamArn,
    streamSequenceNumber: recordIdentifier(record),
    table,
  };
}

export async function processObservabilityDynamoStream(
  event: ObservabilityDynamoStreamEvent,
  table: "execution" | "usage",
  dependencies: ObservabilityNormalizerRuntimeDependencies,
) {
  const failures = new Set<string>();
  const facts: EncodedFact[] = [];
  const normalizationFailures: ObservabilityNormalizationFailure[] = [];
  // Per-invocation only: an organization erased between invocations must never stay cached as live.
  const organizations = new Map<string, Promise<boolean>>();
  let erasedOrganizationFactCount = 0;
  for (const record of event.Records ?? []) {
    let identifier: string;
    try {
      identifier = recordIdentifier(record);
    } catch {
      continue;
    }
    let encoded: EncodedFact[];
    try {
      const current = await decodeImage(record.dynamodb?.NewImage);
      let previous: PlatformRecord | undefined;
      try {
        previous = await decodeImage(record.dynamodb?.OldImage);
      } catch (cause) {
        const old = record.dynamodb?.OldImage;
        // Live writers cannot load a record whose stored image no longer decodes, so a MODIFY from
        // one is an operator repair, which changes no field the projection reads.
        if (
          record.eventName === "MODIFY" &&
          current &&
          old?.itemType?.S === current.itemType &&
          old.data?.M?.status?.S === (current.data as Readonly<Record<string, unknown>>).status
        ) {
          continue;
        }
        throw cause;
      }
      const normalized = await observabilityFactsForTransition(
        transitionFor(
          table,
          record,
          current,
          previous,
          (dependencies.now?.() ?? new Date()).toISOString(),
        ),
      );
      encoded = normalized.map((fact) => encodedFact(fact, identifier));
    } catch (cause) {
      let disposition: "discard" | "retry" = "retry";
      try {
        disposition = await dependencies.quarantine(record, table, cause);
      } catch {
        // The source item remains failed whether quarantine succeeded or not.
      }
      if (disposition === "retry") {
        failures.add(identifier);
        normalizationFailures.push(normalizationFailure(record, table, cause, identifier));
      }
      continue;
    }
    try {
      const retained: EncodedFact[] = [];
      for (const fact of encoded) {
        const organizationId = fact.fact.scope.organizationId;
        let exists = organizations.get(organizationId);
        if (!exists) {
          exists = dependencies.organizationExists(organizationId);
          organizations.set(organizationId, exists);
        }
        if (await exists) retained.push(fact);
        else erasedOrganizationFactCount += 1;
      }
      facts.push(...retained);
    } catch {
      failures.add(identifier);
    }
  }
  if (facts.length > 0) {
    try {
      const failedIndexes = await dependencies.writeFacts(facts);
      for (const index of failedIndexes) {
        const identifier = facts[index]?.sourceIdentifier;
        if (identifier) failures.add(identifier);
      }
    } catch {
      for (const fact of facts) failures.add(fact.sourceIdentifier);
    }
  }
  return {
    batchItemFailures: [...failures].map((itemIdentifier) => ({ itemIdentifier })),
    erasedOrganizationFactCount,
    normalizationFailures,
  };
}

function logNormalizationFailures(
  pipeline: "normalizer-execution" | "normalizer-usage",
  failures: readonly ObservabilityNormalizationFailure[],
) {
  for (const failure of failures) {
    process.stderr.write(
      `${JSON.stringify({ message: "Observability source record was not normalized.", pipeline, ...failure })}\n`,
    );
  }
}

export const executionHandler = async (event: ObservabilityDynamoStreamEvent) => {
  const result = await processObservabilityDynamoStream(event, "execution", runtimeDependencies());
  emitObservabilityFailedRecordsMetric("normalizer-execution", result.batchItemFailures.length);
  emitObservabilityErasedOrganizationFactsMetric(
    "normalizer-execution",
    result.erasedOrganizationFactCount,
  );
  logNormalizationFailures("normalizer-execution", result.normalizationFailures);
  return { batchItemFailures: result.batchItemFailures };
};

export const usageHandler = async (event: ObservabilityDynamoStreamEvent) => {
  const result = await processObservabilityDynamoStream(event, "usage", runtimeDependencies());
  emitObservabilityFailedRecordsMetric("normalizer-usage", result.batchItemFailures.length);
  emitObservabilityErasedOrganizationFactsMetric(
    "normalizer-usage",
    result.erasedOrganizationFactCount,
  );
  logNormalizationFailures("normalizer-usage", result.normalizationFailures);
  return { batchItemFailures: result.batchItemFailures };
};
