import { describe, expect, test } from "bun:test";
import type { Ulid } from "../ids.ts";
import type { EvaluationRunRecord, ReleaseComparisonRecord } from "../records/evaluations.ts";
import { makeEvaluationPersistence } from "./index.ts";
import { evaluationMemoryDatabase } from "./memory-database.fixture.ts";
import {
  OTHER_ENV,
  datasetRunData,
  event,
  fixtureUlid,
  scope,
} from "./evaluation-records.fixture.ts";
import type { EvaluationPersistence, EvaluationRunData, ReleaseComparisonData } from "./index.ts";
import { MAX_FILTERED_PAGE_READS } from "./support.ts";

const otherScope = { ...scope, environmentId: OTHER_ENV };

function at(minute: number) {
  return new Date(Date.UTC(2026, 8, 29, 12, minute)).toISOString();
}

/** IDs in descending order, so creation time — not ID order — must drive the listing. */
function descendingIds(count: number) {
  return Array.from({ length: count }, () => fixtureUlid()).toReversed();
}

async function createRun(
  persistence: EvaluationPersistence,
  input: {
    readonly createdAt: string;
    readonly datasetId?: Ulid;
    readonly environmentId?: Ulid;
    readonly id: Ulid;
    readonly releaseId?: Ulid;
    readonly status?: EvaluationRunData["status"];
  },
) {
  const created = await persistence.createEvaluationRun(
    {
      ...datasetRunData(
        input.id,
        input.datasetId ?? fixtureUlid(),
        input.releaseId ?? fixtureUlid(),
      ),
      createdAt: input.createdAt,
      environmentId: input.environmentId ?? scope.environmentId,
      updatedAt: input.createdAt,
    },
    event("evaluation-run.created"),
  );
  if (input.status === undefined || input.status === "queued") return created;
  return persistence.updateEvaluationRun(
    created,
    { ...created.data, startedAt: input.createdAt, status: input.status, version: 2 },
    event(`evaluation-run.${input.status}`),
  );
}

async function createComparison(
  persistence: EvaluationPersistence,
  input: {
    readonly baselineReleaseId: Ulid;
    readonly candidateReleaseId: Ulid;
    readonly createdAt: string;
    readonly environmentId?: Ulid;
    readonly id: Ulid;
    readonly running?: boolean;
  },
) {
  const datasetId = fixtureUlid();
  const environmentId = input.environmentId ?? scope.environmentId;
  const arm = (role: "baseline" | "candidate", releaseId: Ulid): EvaluationRunData => ({
    ...datasetRunData(fixtureUlid(), datasetId, releaseId),
    comparison: { releaseComparisonId: input.id, role },
    createdAt: input.createdAt,
    environmentId,
    updatedAt: input.createdAt,
  });
  const baseline = arm("baseline", input.baselineReleaseId);
  const candidate = arm("candidate", input.candidateReleaseId);
  const comparison: ReleaseComparisonData = {
    ...scope,
    environmentId,
    baseline: { agentReleaseId: input.baselineReleaseId, evaluationRunId: baseline.id },
    candidate: { agentReleaseId: input.candidateReleaseId, evaluationRunId: candidate.id },
    createdAt: input.createdAt,
    createdByPrincipalId: "principal-1",
    datasetId,
    gateMode: "advisory",
    gatePolicy: {
      maxEvaluatorErrorRate: 0.1,
      maxMeanDecrease: 0.05,
      maxMissingEvidenceRate: 0.1,
      maxNewFailures: 0,
      maxPassRateDecrease: 0.05,
      minComparableCases: 1,
    },
    id: input.id,
    idempotencyKey: `comparison-${input.id}`,
    reasons: [],
    scoreDefinitions: baseline.scoreDefinitions,
    status: "queued",
    updatedAt: input.createdAt,
    version: 1,
  };
  const created = await persistence.createReleaseComparison(
    { baseline, candidate, comparison },
    {
      baseline: event("evaluation-run.created"),
      candidate: event("evaluation-run.created"),
      comparison: event("release-comparison.created"),
    },
  );
  if (!input.running) return created.comparison;
  return persistence.updateReleaseComparison(
    created.comparison,
    { ...created.comparison.data, status: "running", version: 2 },
    event("release-comparison.started"),
  );
}

/** Widened so expectations can list destructured (possibly undefined) fixture IDs. */
const ids = (records: readonly (EvaluationRunRecord | ReleaseComparisonRecord)[]) =>
  records.map((record): string | undefined => record.data.id);

describe("evaluation run history", () => {
  test("indexes runs and comparisons by environment and creation time", async () => {
    const memory = evaluationMemoryDatabase();
    const persistence = makeEvaluationPersistence(memory.database, scope);
    const [runId, comparisonId] = descendingIds(2);
    const run = await createRun(persistence, { createdAt: at(1), id: runId! });
    const comparison = await createComparison(persistence, {
      baselineReleaseId: fixtureUlid(),
      candidateReleaseId: fixtureUlid(),
      createdAt: at(2),
      id: comparisonId!,
    });
    const encodedTime = encodeURIComponent(at(1));
    expect(run.gsi1pk).toBe(
      `ORG#${scope.organizationId}#ENV#${scope.environmentId}#EVALUATION-RUNS`,
    );
    expect(run.gsi1sk).toBe(`${encodedTime}#${runId}`);
    expect(comparison.gsi1pk).toBe(
      `ORG#${scope.organizationId}#ENV#${scope.environmentId}#RELEASE-COMPARISONS`,
    );
    expect(run.gsi2pk).toBe(`ENV#${scope.environmentId}`);
  });

  test("lists only the environment's runs, newest created first, across pages", async () => {
    const memory = evaluationMemoryDatabase();
    const persistence = makeEvaluationPersistence(memory.database, scope);
    const other = makeEvaluationPersistence(memory.database, otherScope);
    const [oldest, middle, newest] = descendingIds(3);
    await createRun(persistence, { createdAt: at(1), id: oldest! });
    await createRun(persistence, { createdAt: at(3), id: newest! });
    await createRun(persistence, { createdAt: at(2), id: middle! });
    const foreign = await createRun(other, {
      createdAt: at(4),
      environmentId: OTHER_ENV,
      id: fixtureUlid(),
    });

    const first = await persistence.listEvaluationRuns({ limit: 2 });
    expect(ids(first.items)).toEqual([newest, middle]);
    expect(first.nextCursor).toBeString();
    const second = await persistence.listEvaluationRuns({ cursor: first.nextCursor, limit: 2 });
    expect(ids(second.items)).toEqual([oldest]);
    expect(second.nextCursor).toBeUndefined();
    expect(ids((await other.listEvaluationRuns({})).items)).toEqual([foreign.data.id]);
  });

  test("filters runs by status, dataset, and target release and pages filtered results", async () => {
    const memory = evaluationMemoryDatabase();
    const persistence = makeEvaluationPersistence(memory.database, scope);
    const datasetId = fixtureUlid();
    const releaseId = fixtureUlid();
    const [a, b, c, d] = descendingIds(4);
    await createRun(persistence, { createdAt: at(1), datasetId, id: a!, releaseId });
    await createRun(persistence, { createdAt: at(2), id: b!, releaseId, status: "running" });
    await createRun(persistence, { createdAt: at(3), datasetId, id: c!, status: "running" });
    await createRun(persistence, {
      createdAt: at(4),
      datasetId,
      id: d!,
      releaseId,
      status: "running",
    });

    expect(ids((await persistence.listEvaluationRuns({ status: "running" })).items)).toEqual([
      d,
      c,
      b,
    ]);
    expect(ids((await persistence.listEvaluationRuns({ datasetId })).items)).toEqual([d, c, a]);
    expect(
      ids((await persistence.listEvaluationRuns({ agentReleaseId: releaseId })).items),
    ).toEqual([d, b, a]);
    expect(
      ids(
        (
          await persistence.listEvaluationRuns({
            agentReleaseId: releaseId,
            datasetId,
            status: "queued",
          })
        ).items,
      ),
    ).toEqual([a]);

    const first = await persistence.listEvaluationRuns({ datasetId, limit: 2 });
    expect(ids(first.items)).toEqual([d, c]);
    const second = await persistence.listEvaluationRuns({
      cursor: first.nextCursor,
      datasetId,
      limit: 2,
    });
    expect(ids(second.items)).toEqual([a]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("returns a partial page with a resumable cursor when a filter matches sparsely", async () => {
    const memory = evaluationMemoryDatabase();
    const persistence = makeEvaluationPersistence(memory.database, scope);
    const datasetId = fixtureUlid();
    const unmatched = MAX_FILTERED_PAGE_READS * 100;
    const runIds = descendingIds(unmatched + 1);
    await createRun(persistence, { createdAt: at(0), datasetId, id: runIds[0]! });
    for (let index = 1; index <= unmatched; index += 1) {
      await createRun(persistence, {
        createdAt: new Date(Date.UTC(2026, 8, 29, 13, 0, 0, index)).toISOString(),
        id: runIds[index]!,
      });
    }

    const first = await persistence.listEvaluationRuns({ datasetId, limit: 1 });
    expect(first.items).toHaveLength(0);
    expect(first.nextCursor).toBeString();
    const second = await persistence.listEvaluationRuns({
      cursor: first.nextCursor,
      datasetId,
      limit: 1,
    });
    expect(ids(second.items)).toEqual([runIds[0]]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("rejects a cursor from another environment's history", async () => {
    const memory = evaluationMemoryDatabase();
    const persistence = makeEvaluationPersistence(memory.database, scope);
    const other = makeEvaluationPersistence(memory.database, otherScope);
    await createRun(other, { createdAt: at(1), environmentId: OTHER_ENV, id: fixtureUlid() });
    await createRun(other, { createdAt: at(2), environmentId: OTHER_ENV, id: fixtureUlid() });
    const foreign = await other.listEvaluationRuns({ limit: 1 });
    expect(
      persistence.listEvaluationRuns({ cursor: foreign.nextCursor, limit: 1 }),
    ).rejects.toMatchObject({ code: "invalid_cursor", kind: "invalid-input" });
  });
});

describe("release comparison history", () => {
  test("lists the environment's comparisons newest first and filters by release and status", async () => {
    const memory = evaluationMemoryDatabase();
    const persistence = makeEvaluationPersistence(memory.database, scope);
    const other = makeEvaluationPersistence(memory.database, otherScope);
    const baseline = fixtureUlid();
    const candidate = fixtureUlid();
    const [a, b, c] = descendingIds(3);
    await createComparison(persistence, {
      baselineReleaseId: baseline,
      candidateReleaseId: candidate,
      createdAt: at(1),
      id: a!,
    });
    await createComparison(persistence, {
      baselineReleaseId: baseline,
      candidateReleaseId: fixtureUlid(),
      createdAt: at(2),
      id: b!,
      running: true,
    });
    await createComparison(persistence, {
      baselineReleaseId: fixtureUlid(),
      candidateReleaseId: candidate,
      createdAt: at(3),
      id: c!,
      running: true,
    });
    await createComparison(other, {
      baselineReleaseId: baseline,
      candidateReleaseId: candidate,
      createdAt: at(4),
      environmentId: OTHER_ENV,
      id: fixtureUlid(),
    });

    const first = await persistence.listReleaseComparisons({ limit: 2 });
    expect(ids(first.items)).toEqual([c, b]);
    const second = await persistence.listReleaseComparisons({
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(ids(second.items)).toEqual([a]);
    expect(second.nextCursor).toBeUndefined();
    expect(
      ids((await persistence.listReleaseComparisons({ baselineReleaseId: baseline })).items),
    ).toEqual([b, a]);
    expect(
      ids((await persistence.listReleaseComparisons({ candidateReleaseId: candidate })).items),
    ).toEqual([c, a]);
    expect(ids((await persistence.listReleaseComparisons({ status: "running" })).items)).toEqual([
      c,
      b,
    ]);
    expect(
      ids(
        (
          await persistence.listReleaseComparisons({
            baselineReleaseId: baseline,
            candidateReleaseId: candidate,
            status: "queued",
          })
        ).items,
      ),
    ).toEqual([a]);
  });
});
