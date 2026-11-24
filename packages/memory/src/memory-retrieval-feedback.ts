import {
  MemoryRetrievalRecord,
  key,
  recordTtlPassed,
  withCanonicalRecordKeys,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import type { MemorySearchContext } from "./platform-search.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";

export function makeMemoryRetrievalFeedback(context: MemorySearchContext) {
  const {
    database,
    dependencies: _dependencies,
    generateId: _generateId,
    now,
    searchService: _searchService,
    resolveMemoryContent: _resolveMemoryContent,
    requiredSpace: _requiredSpace,
    effectivePolicy: _effectivePolicy,
    eventFor: _eventFor,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
  } = context;

  async function recordRetrievalFeedback(
    scope: Types.MemoryPlatformScope,
    retrievalId: Ulid,
    memoryId: Ulid,
    usefulness: Types.MemoryRetrieval["data"]["usefulness"],
    feedback?: string,
    input: { readonly idempotencyKey?: string } = {},
  ) {
    const normalizedFeedback = feedback?.trim()
      ? Shared.requireText(feedback, "Feedback", 2_000)
      : undefined;
    const idempotencyKey = input.idempotencyKey?.trim();
    const expectedCommandHash = Shared.commandHash({
      feedback: normalizedFeedback,
      memoryId,
      operation: "memory-retrieval.feedback",
      retrievalId,
      usefulness,
    });
    const retrievalKey = {
      pk: key("ORG", scope.organizationId, "MEMORY", memoryId),
      sk: key("MEMORY-RETRIEVAL", retrievalId),
    };
    const replay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
    if (replay?.[0]) {
      const replayed = await Shared.loadRecord(
        database,
        "execution",
        retrievalKey,
        "memory-retrieval",
      );
      if (
        replayed &&
        Shared.mutationScopeMatches(replayed, scope) &&
        !recordTtlPassed(replayed, now())
      ) {
        return replayed;
      }
    }
    const previous = await Shared.loadRecord(
      database,
      "execution",
      retrievalKey,
      "memory-retrieval",
    );
    if (
      !previous ||
      !Shared.mutationScopeMatches(previous, scope) ||
      recordTtlPassed(previous, now())
    ) {
      throw new Types.MemoryPlatformError(
        404,
        "retrieval_not_found",
        "Memory retrieval was not found.",
      );
    }
    if (
      previous.data.usefulness === usefulness &&
      (normalizedFeedback === undefined || previous.data.feedback === normalizedFeedback)
    ) {
      if (idempotencyKey) {
        const timestampDate = now();
        try {
          await memoryPersistence.commit(database, [
            {
              conditionExpression: "#data.#version = :version AND #itemType = :itemType",
              expressionAttributeNames: {
                "#data": "data",
                "#itemType": "itemType",
                "#version": "version",
              },
              expressionAttributeValues: {
                ":itemType": "memory-retrieval",
                ":version": previous.data.version,
              },
              key: retrievalKey,
              kind: "condition-check",
              table: "execution",
            },
            idempotencyOperation(
              completedIdempotency({
                commandHash: expectedCommandHash,
                idempotencyKey,
                resourceIds: [previous.data.id],
                scope,
                timestamp: timestampDate,
              }),
            ),
          ]);
        } catch (cause) {
          const concurrentReplay = await idempotencyReplay(
            scope,
            idempotencyKey,
            expectedCommandHash,
          );
          if (concurrentReplay?.[0]) {
            const replayed = await Shared.loadRecord(
              database,
              "execution",
              retrievalKey,
              "memory-retrieval",
            );
            if (replayed && Shared.scopeMatches(replayed, scope)) return replayed;
          }
          throw cause;
        }
      }
      return previous;
    }
    const next = Shared.record(
      MemoryRetrievalRecord,
      withCanonicalRecordKeys({
        data: {
          ...previous.data,
          ...(normalizedFeedback ? { feedback: normalizedFeedback } : {}),
          usefulness,
          version: previous.data.version + 1,
        },
        itemType: "memory-retrieval" as const,
      }),
    );
    const operations: TransactionOperation[] = [
      { kind: "put", previousRecord: previous, record: next },
    ];
    if (idempotencyKey) {
      operations.push(
        idempotencyOperation(
          completedIdempotency({
            commandHash: expectedCommandHash,
            idempotencyKey,
            resourceIds: [next.data.id],
            scope,
            timestamp: now(),
          }),
        ),
      );
    }
    try {
      await memoryPersistence.commit(database, operations);
    } catch (cause) {
      const concurrentReplay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
      if (concurrentReplay?.[0]) {
        const replayed = await Shared.loadRecord(
          database,
          "execution",
          retrievalKey,
          "memory-retrieval",
        );
        if (replayed && Shared.scopeMatches(replayed, scope)) return replayed;
      }
      throw cause;
    }
    return next;
  }
  return recordRetrievalFeedback;
}
