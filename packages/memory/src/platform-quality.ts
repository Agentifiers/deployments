import { key, recordTtlPassed, type Ulid, memoryPersistence } from "@deployments-ai/db";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
export function makeMemoryPlatformQuality(runtime: Shared.MemoryPlatformRuntime) {
  const { database, now } = runtime;

  async function quality(
    scope: Types.MemoryPlatformScope,
    input: { readonly limit?: number; readonly since?: string } = {},
  ) {
    const currentTime = now().getTime();
    const since = input.since
      ? Date.parse(input.since)
      : currentTime - Shared.DEFAULT_QUALITY_WINDOW_MS;
    const sampleLimit = Shared.qualitySampleLimit(input.limit);
    if (Number.isNaN(since)) {
      throw new Types.MemoryPlatformError(
        400,
        "invalid_since",
        "Memory quality since must be a valid timestamp.",
      );
    }
    if (since < currentTime - Shared.MAX_QUALITY_WINDOW_MS) {
      throw new Types.MemoryPlatformError(
        400,
        "invalid_since",
        "Memory quality since must be within the last 90 days.",
      );
    }
    async function telemetry<T extends Types.MemoryRecallAttempt | Types.MemoryRetrieval>(
      itemType: T["itemType"],
    ) {
      const served = new Map<Ulid, T>();
      const shadow = new Map<Ulid, T>();
      const scanBudget = sampleLimit * 4;
      let scanned = 0;
      const telemetryPartition = scope.workspaceId
        ? key(
            "ENV",
            scope.environmentId,
            "ORG",
            scope.organizationId,
            "PROJECT",
            scope.projectId,
            "WORKSPACE",
            scope.workspaceId,
            "MEMORY-TELEMETRY",
            itemType,
          )
        : key(
            "ENV",
            scope.environmentId,
            "ORG",
            scope.organizationId,
            "PROJECT",
            scope.projectId,
            "MEMORY-TELEMETRY",
            itemType,
          );
      const indexName = scope.workspaceId ? "gsi2" : "gsi1";
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const remaining = scanBudget - scanned;
        const result = await memoryPersistence.find(database, "execution", {
          ExpressionAttributeValues: {
            ":pk": telemetryPartition,
            ":since": key(new Date(since).toISOString()),
          },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          IndexName: indexName,
          KeyConditionExpression: `${indexName}pk = :pk AND ${indexName}sk >= :since`,
          Limit: Math.min(Shared.MAX_LIMIT, Math.max(1, remaining)),
          ScanIndexForward: false,
        });
        scanned += result.items.length;
        for (const value of result.items) {
          if (
            value.itemType === itemType &&
            Shared.telemetryScopeMatches(value, scope) &&
            Date.parse(value.data.createdAt) >= since &&
            !recordTtlPassed(value, new Date(currentTime))
          ) {
            const target = value.data.shadow === true ? shadow : served;
            if (target.size < sampleLimit) target.set(value.data.id, value as T);
          }
        }
        exclusiveStartKey = result.lastEvaluatedKey;
      } while (
        exclusiveStartKey &&
        scanned < scanBudget &&
        (served.size < sampleLimit || shadow.size < sampleLimit)
      );

      const samples = (records: ReadonlyMap<Ulid, T>) =>
        [...records.values()]
          .sort((left, right) => right.data.createdAt.localeCompare(left.data.createdAt))
          .slice(0, sampleLimit);
      return { served: samples(served), shadow: samples(shadow) };
    }
    const attempts = await telemetry<Types.MemoryRecallAttempt>("memory-recall-attempt");
    const retrievals = await telemetry<Types.MemoryRetrieval>("memory-retrieval");
    const servedAttempts = attempts.served;
    const shadowAttempts = attempts.shadow;
    const servedRetrievals = retrievals.served;
    const shadowRetrievals = retrievals.shadow;
    const latencies = servedAttempts
      .flatMap((attempt) => (attempt.data.latencyMs === undefined ? [] : [attempt.data.latencyMs]))
      .sort((a, b) => a - b);
    const percentile = (p: number) =>
      latencies.length === 0
        ? undefined
        : latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)];
    const usefulness = { harmful: 0, neutral: 0, useful: 0, unreviewed: 0 };
    for (const retrieval of servedRetrievals) {
      if (retrieval.data.usefulness) usefulness[retrieval.data.usefulness] += 1;
      else usefulness.unreviewed += 1;
    }
    const completedAttempts = servedAttempts.filter(
      (attempt) => attempt.data.status === "completed",
    );
    const totals = completedAttempts.reduce(
      (value, attempt) => ({
        candidates: value.candidates + attempt.data.candidateCount,
        canonicalDrops: value.canonicalDrops + (attempt.data.canonicalDropCount ?? 0),
        duplicates: value.duplicates + (attempt.data.duplicateCount ?? 0),
      }),
      { candidates: 0, canonicalDrops: 0, duplicates: 0 },
    );
    const strategySummary = (samples: readonly Types.MemoryRecallAttempt[]) =>
      Object.fromEntries(
        [...new Set(samples.map((attempt) => attempt.data.strategy))].map((strategy) => {
          const strategySamples = samples.filter((attempt) => attempt.data.strategy === strategy);
          return [
            strategy,
            {
              attempts: strategySamples.length,
              completed: strategySamples.filter((attempt) => attempt.data.status === "completed")
                .length,
              failed: strategySamples.filter((attempt) => attempt.data.status === "failed").length,
            },
          ];
        }),
      );
    const strategies = strategySummary(servedAttempts);
    const shadowStrategies = strategySummary(shadowAttempts);
    return {
      attempts: servedAttempts.length,
      canonicalDropRate: totals.candidates === 0 ? 0 : totals.canonicalDrops / totals.candidates,
      completed: completedAttempts.length,
      duplicateRate: totals.candidates === 0 ? 0 : totals.duplicates / totals.candidates,
      failed: servedAttempts.filter((attempt) => attempt.data.status === "failed").length,
      latencyMs: {
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        samples: latencies.length,
      },
      retrievals: servedRetrievals.length,
      sampleLimit,
      shadow: {
        attempts: shadowAttempts.length,
        completed: shadowAttempts.filter((attempt) => attempt.data.status === "completed").length,
        failed: shadowAttempts.filter((attempt) => attempt.data.status === "failed").length,
        retrievals: shadowRetrievals.length,
        strategies: shadowStrategies,
      },
      strategies,
      usefulness,
    };
  }

  return {
    quality,
  };
}
