import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  decodePlatformRecord,
  makeDynamoDatabase,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import { Effect } from "effect";
import { createSqsEvaluationQueueSender, type EvaluationQueueSender } from "./evaluation-ports.ts";
import { failureChain } from "./failure-log.ts";
import {
  providerMutationClaimSettled,
  repairTraceFinalization,
  repairTraceFinalizationForRunId,
} from "./trace-finalization.ts";

export interface TraceFinalizationStreamRecord {
  readonly dynamodb?: {
    readonly Keys?: Record<string, AttributeValue>;
    readonly NewImage?: Record<string, AttributeValue>;
    readonly OldImage?: Record<string, AttributeValue>;
    readonly SequenceNumber?: string;
  };
  readonly eventID?: string;
  readonly eventName?: string;
}

export interface TraceFinalizationStreamEvent {
  readonly Records?: readonly TraceFinalizationStreamRecord[];
}

let database = makeDynamoDatabase(
  DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }),
  tableNamesFromEnvironment(),
);

export function setTraceFinalizationDatabaseForTest(value: typeof database) {
  database = value;
}

const EVALUATION_QUEUE_URL_ENV = "DEPLOYMENTS_AI_EVALUATION_QUEUE_URL";
let evaluationQueue:
  | { readonly queueUrl: string; readonly sender: EvaluationQueueSender }
  | undefined;
let evaluationQueueFactory = (queueUrl: string) => createSqsEvaluationQueueSender({ queueUrl });

export function setTraceFinalizationEvaluationQueueForTest(
  factory: (queueUrl: string) => EvaluationQueueSender,
) {
  evaluationQueueFactory = factory;
  evaluationQueue = undefined;
}

/** The automatic-scoring queue, or undefined when evaluations are not configured. */
function evaluationQueueSender() {
  const queueUrl = process.env[EVALUATION_QUEUE_URL_ENV]?.trim();
  if (!queueUrl) return undefined;
  if (evaluationQueue?.queueUrl !== queueUrl) {
    evaluationQueue = { queueUrl, sender: evaluationQueueFactory(queueUrl) };
  }
  return evaluationQueue.sender;
}

function previouslyFinalized(image: Record<string, AttributeValue> | undefined) {
  if (!image) return false;
  const previous: { readonly data?: { readonly status?: unknown } } = unmarshall(image);
  return previous.data?.status === "finalized";
}

function traceFinalizationFailureIdentifier(record: TraceFinalizationStreamRecord) {
  const sequenceNumber = record.dynamodb?.SequenceNumber?.trim();
  if (!sequenceNumber) {
    throw new Error("Trace finalization stream record failed without a sequence number.");
  }
  return sequenceNumber;
}

export async function handler(event: TraceFinalizationStreamEvent) {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    const image = record.dynamodb?.NewImage ?? record.dynamodb?.OldImage;
    if (!["INSERT", "MODIFY", "REMOVE"].includes(record.eventName ?? "") || !image) {
      continue;
    }
    try {
      const decoded = await Effect.runPromise(decodePlatformRecord(unmarshall(image)));
      if (decoded.itemType === "trace") {
        const queue = evaluationQueueSender();
        if (
          queue &&
          record.eventName !== "REMOVE" &&
          decoded.data.status === "finalized" &&
          !previouslyFinalized(record.dynamodb?.OldImage)
        ) {
          await queue.send({
            environmentId: decoded.data.environmentId,
            organizationId: decoded.data.organizationId,
            projectId: decoded.data.projectId,
            traceId: decoded.data.traceId,
            type: "trace.score",
          });
        }
      } else if (
        decoded.itemType === "run" &&
        ["canceled", "completed", "failed"].includes(decoded.data.status)
      ) {
        await repairTraceFinalization(database, {
          environmentId: decoded.data.environmentId,
          organizationId: decoded.data.organizationId,
          runId: decoded.data.id,
          runPk: decoded.pk,
          runSk: decoded.sk,
          traceId: decoded.data.traceId,
        });
      } else if (
        decoded.itemType === "provider-mutation-claim" &&
        // Only removing an open claim closes an operation. Retention removes settled claims while
        // it deletes the trace's other records, and re-evaluating that half-deleted trace reopens it.
        (record.eventName === "REMOVE"
          ? !providerMutationClaimSettled(decoded)
          : providerMutationClaimSettled(decoded))
      ) {
        await repairTraceFinalizationForRunId(
          database,
          {
            environmentId: decoded.data.environmentId,
            organizationId: decoded.data.organizationId,
            projectId: decoded.data.projectId,
            runId: decoded.data.runId,
          },
          {
            allowMissingRun: record.eventName === "REMOVE",
          },
        );
      } else if (
        decoded.itemType === "memory-flush" &&
        ["failed", "queued", "running", "succeeded"].includes(decoded.data.status)
      ) {
        await repairTraceFinalizationForRunId(database, {
          environmentId: decoded.data.environmentId,
          organizationId: decoded.data.organizationId,
          projectId: decoded.data.projectId,
          runId: decoded.data.runId,
        });
      } else if (
        record.eventName === "INSERT" &&
        decoded.itemType === "meter-event" &&
        decoded.data.metric === "model_tokens" &&
        decoded.data.unit === "tokens" &&
        decoded.data.runId !== undefined &&
        decoded.data.observability !== undefined
      ) {
        await repairTraceFinalizationForRunId(database, {
          environmentId: decoded.data.environmentId,
          organizationId: decoded.data.organizationId,
          projectId: decoded.data.projectId,
          runId: decoded.data.runId,
        });
      }
    } catch (cause) {
      const itemIdentifier = traceFinalizationFailureIdentifier(record);
      failures.push({ itemIdentifier });
      process.stderr.write(
        `${JSON.stringify({
          message: "Trace finalization stream record failed.",
          eventName: record.eventName,
          failure: failureChain(cause),
          itemType: image.itemType?.S,
          pk: record.dynamodb?.Keys?.pk?.S,
          sequenceNumber: itemIdentifier,
        })}\n`,
      );
    }
  }
  return { batchItemFailures: failures };
}
