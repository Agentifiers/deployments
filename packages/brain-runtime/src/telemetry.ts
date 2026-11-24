import type { BrainQueryTelemetryPort } from "@deployments-ai/brains";
import {
  BrainQueryAttemptRecord,
  BrainRetrievalRecord,
  MeterEventRecord,
  makeIdGenerator,
  transactionItemCount,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type TransactionOperation,
  brainRuntimePersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";

const TRANSACTION_ITEM_LIMIT = 100;

function contextTokens(results: Parameters<BrainQueryTelemetryPort["record"]>[0]["results"]) {
  return results.reduce(
    (total, result) => total + Math.ceil(Array.from(result.excerpt).length / 3),
    0,
  );
}

/**
 * The attempt and its meter commit in the last transaction, so a query is billed and
 * reported only after every retrieval it ranked has been stored.
 */
function telemetryTransactions(
  attempt: TransactionOperation,
  retrievals: readonly TransactionOperation[],
  meter: TransactionOperation | undefined,
) {
  const closing = meter ? [meter] : [];
  let split = 0;
  while (
    transactionItemCount([attempt, ...retrievals.slice(split), ...closing]) > TRANSACTION_ITEM_LIMIT
  ) {
    split += 1;
  }
  const leading: TransactionOperation[][] = [];
  for (const retrieval of retrievals.slice(0, split)) {
    const current = leading.at(-1);
    if (current && transactionItemCount([...current, retrieval]) <= TRANSACTION_ITEM_LIMIT) {
      current.push(retrieval);
    } else {
      leading.push([retrieval]);
    }
  }
  return { final: [attempt, ...retrievals.slice(split), ...closing], leading };
}

export function makeDynamoBrainQueryTelemetry(input: {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Promise<string>;
  readonly now?: () => Date;
}): BrainQueryTelemetryPort {
  const ids = makeIdGenerator();
  const generateId = input.generateId ?? (async () => ids.generate());
  return {
    async record(value) {
      const occurredAt = (input.now ?? (() => new Date()))().toISOString();
      const queryAttemptId = await generateId();
      const tokenCount = contextTokens(value.results);
      const queryAttempt = Schema.decodeUnknownSync(BrainQueryAttemptRecord)(
        withCanonicalRecordKeys({
          data: {
            authorizedBrainCount: new Set(value.authorizedBrainIds).size,
            candidateCount: value.candidateCount,
            canonicalDropCount: value.canonicalDropCount,
            contextTokens: tokenCount,
            createdAt: occurredAt,
            emittedCount: value.emittedCount,
            ...(value.context?.environmentId ? { environmentId: value.context.environmentId } : {}),
            id: queryAttemptId,
            latencyMs: value.latencyMs,
            organizationId: value.organizationId,
            placementGeneration: value.placementGeneration,
            ...(value.context?.projectId ? { projectId: value.context.projectId } : {}),
            provider: value.target.providerId,
            purpose: value.context?.purpose ?? value.purpose,
            queryHash: createHash("sha256").update(value.query).digest("hex"),
            ...(value.context?.runId
              ? { runId: value.context.runId, threadId: value.context.threadId }
              : {}),
            schemaGeneration: value.target.schemaGeneration,
            status: "completed" as const,
            targetId: value.target.targetId,
            ...(value.context?.toolCallId ? { toolCallId: value.context.toolCallId } : {}),
            version: 0,
          },
          itemType: "brain-query-attempt" as const,
        }),
      );
      const retrievals = await Promise.all(
        value.results.map(async (result, rank) =>
          Schema.decodeUnknownSync(BrainRetrievalRecord)(
            withCanonicalRecordKeys({
              data: {
                brainId: result.citation.brainId,
                chunkId: result.citation.chunkId,
                contextTokens: Math.ceil(Array.from(result.excerpt).length / 3),
                createdAt: occurredAt,
                documentId: result.citation.documentId,
                documentVersionId: result.citation.documentVersionId,
                ...(value.context?.environmentId
                  ? { environmentId: value.context.environmentId }
                  : {}),
                id: await generateId(),
                injected: value.purpose === "ask-evidence",
                organizationId: value.organizationId,
                ...(value.context?.projectId ? { projectId: value.context.projectId } : {}),
                provider: value.target.providerId,
                purpose: value.context?.purpose ?? value.purpose,
                queryAttemptId,
                rank,
                renditionId: result.citation.renditionId,
                ...(value.context?.runId
                  ? { runId: value.context.runId, threadId: value.context.threadId }
                  : {}),
                score: result.score,
                sourceId: result.citation.sourceId,
                ...(value.context?.toolCallId ? { toolCallId: value.context.toolCallId } : {}),
                version: 0,
              },
              itemType: "brain-retrieval" as const,
            }),
          ),
        ),
      );
      const meter =
        value.context?.environmentId && value.context.projectId
          ? Schema.decodeUnknownSync(MeterEventRecord)(
              withCanonicalRecordKeys({
                data: {
                  dimensions: {
                    authorizedBrainCount: new Set(value.authorizedBrainIds).size,
                    candidateCount: value.candidateCount,
                    provider: value.target.providerId,
                    targetId: value.target.targetId,
                  },
                  environmentId: value.context.environmentId,
                  id: await generateId(),
                  idempotencyKey: `brain-query:${value.context.operationId ?? queryAttemptId}`,
                  metric: "brain.retrieval",
                  ...(value.context.observability
                    ? { observability: value.context.observability }
                    : {}),
                  occurredAt,
                  organizationId: value.organizationId,
                  projectId: value.context.projectId,
                  quantity: 1,
                  ...(value.context.runId ? { runId: value.context.runId } : {}),
                  source: "brain-runtime",
                  unit: "request",
                  ...(value.context.workspaceId ? { workspaceId: value.context.workspaceId } : {}),
                },
                itemType: "meter-event" as const,
              }),
            )
          : undefined;
      const meterPut: TransactionOperation | undefined = meter
        ? { kind: "put", record: meter }
        : undefined;
      const transactions = telemetryTransactions(
        { kind: "put", record: queryAttempt },
        retrievals.map((record) => ({ kind: "put" as const, record })),
        meterPut,
      );
      await Promise.all(
        transactions.leading.map((operations) =>
          brainRuntimePersistence.commit(input.database, operations),
        ),
      );
      try {
        await brainRuntimePersistence.commit(input.database, transactions.final);
      } catch (cause) {
        // An earlier attempt under this idempotency key already billed the retrieval.
        const billed =
          meter &&
          value.context?.operationId &&
          (await brainRuntimePersistence.read(input.database, "usage", {
            pk: meter.pk,
            sk: meter.sk,
          }));
        if (!billed) throw cause;
        await brainRuntimePersistence.commit(
          input.database,
          transactions.final.filter((operation) => operation !== meterPut),
        );
      }
      return { queryAttemptId };
    },
  };
}
