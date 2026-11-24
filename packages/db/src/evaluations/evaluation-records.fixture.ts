import type { Ulid } from "../ids.ts";
import type { DatasetCaseData } from "./datasets.ts";
import type { ScoreDefinitionData, ScoreDefinitionRevisionData } from "./definitions.ts";
import type { EvaluationCaseRunData, EvaluationRunData } from "./runs.ts";
import type { ScoreResultData } from "./scores.ts";
import type { EvaluationPersistenceEvent, EvaluationScope } from "./support.ts";

const ORG = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENV = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
export const OTHER_ENV = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
export const NOW = "2026-09-29T12:00:00.000Z";
export const LATER = "2026-09-29T13:00:00.000Z";
export const TRACE = "0123456789abcdef0123456789abcdef";
export const scope: EvaluationScope = {
  environmentId: ENV,
  organizationId: ORG,
  projectId: PROJECT,
};

let sequence = 0;
/** Deterministic, strictly increasing ULIDs for fixtures. */
export function fixtureUlid(): Ulid {
  sequence += 1;
  return `01J${String(sequence).padStart(23, "0")}` as Ulid;
}

export function event(eventType: string): EvaluationPersistenceEvent {
  return {
    eventId: fixtureUlid(),
    eventType,
    occurredAt: NOW,
    payload: { deploymentsAiInternal: true },
  };
}

export function definitionData(
  id: Ulid,
  overrides: Partial<ScoreDefinitionData> = {},
): ScoreDefinitionData {
  return {
    ...scope,
    createdAt: NOW,
    createdByPrincipalId: "principal-1",
    currentRevision: 1,
    id,
    name: "mentions-refund",
    ownerPrincipalId: "principal-1",
    status: "active",
    type: "deterministic",
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

export function revisionData(
  scoreDefinitionId: Ulid,
  overrides: Partial<ScoreDefinitionRevisionData> = {},
): ScoreDefinitionRevisionData {
  return {
    ...scope,
    createdAt: NOW,
    createdByPrincipalId: "principal-1",
    evaluator: { kind: "contains", values: ["refund"] },
    evaluatorVersionHash: "a".repeat(64),
    id: fixtureUlid(),
    revision: 1,
    sampling: { rate: 0 },
    scoreDefinitionId,
    status: "active",
    target: "root-run",
    threshold: 1,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

export function caseData(datasetId: Ulid, contentSha256: string): DatasetCaseData {
  return {
    ...scope,
    contentSha256,
    createdAt: NOW,
    createdByPrincipalId: "principal-1",
    datasetId,
    expectationKinds: ["mustInclude"],
    id: fixtureUlid(),
    inputPreview: "Where is my refund?",
    material: {
      bucket: "artifacts",
      byteSize: 120,
      contentType: "application/json",
      key: `organizations/${ORG}/evaluation-cases/${datasetId}/${contentSha256}.json`,
      sha256: contentSha256,
      versionId: "v1",
    },
    provenance: "manual",
    tags: [],
  };
}

export function datasetRunData(id: Ulid, datasetId: Ulid, releaseId: Ulid): EvaluationRunData {
  return {
    ...scope,
    caseCount: 0,
    caseTimeoutSeconds: 600,
    concurrency: 5,
    counts: { failed: 0, pending: 0, running: 0, scored: 0, timedOut: 0 },
    createdAt: NOW,
    createdByPrincipalId: "principal-1",
    datasetId,
    id,
    idempotencyKey: `create-${id}`,
    kind: "dataset-replay",
    scoreDefinitions: [
      {
        evaluatorVersionHash: "a".repeat(64),
        name: "mentions-refund",
        revision: 1,
        scoreDefinitionId: fixtureUlid(),
        threshold: 1,
        type: "deterministic",
      },
    ],
    status: "queued",
    target: { agentReleaseId: releaseId, type: "release" },
    updatedAt: NOW,
    version: 1,
  };
}

export function caseRunData(evaluationRunId: Ulid, caseKey: string): EvaluationCaseRunData {
  return {
    ...scope,
    attempts: 0,
    caseKey,
    createdAt: NOW,
    evaluationRunId,
    notApplicable: [],
    scores: [],
    status: "pending",
    updatedAt: NOW,
    version: 1,
  };
}

export function scoreData(overrides: Partial<ScoreResultData> = {}): ScoreResultData {
  return {
    ...scope,
    createdAt: NOW,
    durationMs: 3,
    evaluatorVersionHash: "a".repeat(64),
    evidenceRefs: [],
    executionStatus: "succeeded",
    id: fixtureUlid(),
    idempotencyKey: "score-1",
    passed: true,
    revision: 1,
    scoreDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid,
    scoreType: "deterministic",
    source: "evaluation-run",
    threshold: 1,
    traceId: TRACE as ScoreResultData["traceId"],
    updatedAt: NOW,
    value: 1,
    version: 1,
    ...overrides,
  };
}
