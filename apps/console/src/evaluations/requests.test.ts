import { describe, expect, test } from "bun:test";
import {
  comparisonRequest,
  evaluationRunRequest,
  MAX_IMPORTED_CASES,
  optionalNumber,
  parseCaseFile,
  scorerConfiguration,
  type ComparisonForm,
} from "./requests.ts";

const BASELINE = "01M3SMDX3JA4BCHC1FBXZYFEZD";
const CANDIDATE = "01M3SME0RMA6Z4TT11ZXAXCHPA";
const DATASET = "01M3SM0000000000000000DATA";
const SCORER = "01M3SM00000000000000SC0RER";

const comparisonForm: ComparisonForm = {
  baselineReleaseId: BASELINE,
  candidateReleaseId: CANDIDATE,
  caseTimeoutSeconds: "",
  concurrency: "",
  datasetId: DATASET,
  gatePolicy: {
    maxEvaluatorErrorRate: "",
    maxMeanDecrease: "",
    maxMissingEvidenceRate: "",
    maxNewFailures: "",
    maxPassRateDecrease: "",
    minComparableCases: "",
  },
  runtimeConfigFromAgentDeploymentId: "",
  scoreDefinitionIds: [SCORER],
};

describe("optionalNumber", () => {
  test("blank and whitespace mean the API default", () => {
    expect(optionalNumber("  ", "Concurrency")).toEqual({ ok: true, value: undefined });
  });

  test("rejects text that would serialize as null", () => {
    expect(optionalNumber("ten", "Concurrency")).toEqual({
      error: "Concurrency must be a number.",
      ok: false,
    });
    expect(optionalNumber("Infinity", "Concurrency").ok).toBe(false);
  });

  test("keeps zero, which is a meaningful threshold", () => {
    expect(optionalNumber("0", "Threshold")).toEqual({ ok: true, value: 0 });
  });
});

describe("parseCaseFile", () => {
  test("accepts a bare array or the import request shape", () => {
    const cases = [{ message: "Where is my refund?" }];
    expect(parseCaseFile(JSON.stringify(cases))).toEqual({ ok: true, value: cases });
    expect(parseCaseFile(JSON.stringify({ cases }))).toEqual({ ok: true, value: cases });
  });

  test("rejects malformed, empty, non-array, and oversized files", () => {
    expect(parseCaseFile("[{")).toMatchObject({ ok: false });
    expect(parseCaseFile("")).toMatchObject({ ok: false });
    expect(parseCaseFile("[]")).toEqual({ error: "The case file has no cases.", ok: false });
    expect(parseCaseFile('{"message":"hi"}')).toMatchObject({ ok: false });
    const tooMany = Array.from({ length: MAX_IMPORTED_CASES + 1 }, () => ({ message: "x" }));
    expect(parseCaseFile(JSON.stringify(tooMany))).toMatchObject({ ok: false });
  });
});

describe("comparisonRequest", () => {
  test("omits blank controls and an all-blank gate policy", () => {
    expect(comparisonRequest(comparisonForm)).toEqual({
      ok: true,
      value: {
        baselineReleaseId: BASELINE,
        candidateReleaseId: CANDIDATE,
        datasetId: DATASET,
        scoreDefinitionIds: [SCORER],
      },
    });
  });

  test("sends only the gate thresholds that were filled in", () => {
    const result = comparisonRequest({
      ...comparisonForm,
      concurrency: "4",
      gatePolicy: { ...comparisonForm.gatePolicy, maxNewFailures: "0" },
      runtimeConfigFromAgentDeploymentId: DATASET,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        baselineReleaseId: BASELINE,
        candidateReleaseId: CANDIDATE,
        concurrency: 4,
        datasetId: DATASET,
        gatePolicy: { maxNewFailures: 0 },
        runtimeConfigFromAgentDeploymentId: DATASET,
        scoreDefinitionIds: [SCORER],
      },
    });
  });

  test("refuses comparing a release with itself", () => {
    expect(comparisonRequest({ ...comparisonForm, candidateReleaseId: BASELINE })).toEqual({
      error: "Baseline and candidate releases must differ.",
      ok: false,
    });
  });

  test("reports which gate field is not a number", () => {
    const result = comparisonRequest({
      ...comparisonForm,
      gatePolicy: { ...comparisonForm.gatePolicy, maxMeanDecrease: "a lot" },
    });
    expect(result).toEqual({ error: "Max mean decrease must be a number.", ok: false });
  });
});

describe("evaluationRunRequest", () => {
  const base = {
    agentReleaseId: CANDIDATE,
    caseTimeoutSeconds: "",
    concurrency: "",
    datasetId: DATASET,
    kind: "dataset-replay" as const,
    runtimeConfigFromAgentDeploymentId: "",
    scoreDefinitionIds: [SCORER],
    traceIds: "",
  };

  test("builds a release-targeted dataset replay", () => {
    expect(evaluationRunRequest({ ...base, caseTimeoutSeconds: "120" })).toEqual({
      ok: true,
      value: {
        caseTimeoutSeconds: 120,
        datasetId: DATASET,
        kind: "dataset-replay",
        scoreDefinitionIds: [SCORER],
        target: { agentReleaseId: CANDIDATE, type: "release" },
      },
    });
  });

  test("splits trace IDs on commas, spaces, and lines and ignores replay fields", () => {
    const first = "a".repeat(32);
    const second = "b".repeat(32);
    expect(
      evaluationRunRequest({ ...base, kind: "trace-score", traceIds: `${first},\n ${second} ` }),
    ).toEqual({
      ok: true,
      value: { kind: "trace-score", scoreDefinitionIds: [SCORER], traceIds: [first, second] },
    });
  });

  test("requires a scorer", () => {
    expect(evaluationRunRequest({ ...base, scoreDefinitionIds: [] }).ok).toBe(false);
  });
});

describe("scorerConfiguration", () => {
  test("wraps the sampling rate in its policy object and omits blank fields", () => {
    expect(
      scorerConfiguration({
        evaluator: '{"kind":"contains"}',
        samplingRate: "0.1",
        target: "",
        threshold: "",
        weight: "",
      }),
    ).toEqual({ ok: true, value: { evaluator: { kind: "contains" }, sampling: { rate: 0.1 } } });
  });

  test("rejects an evaluator that is not a JSON object", () => {
    expect(
      scorerConfiguration({
        evaluator: '["contains"]',
        samplingRate: "",
        target: "trace",
        threshold: "1",
        weight: "",
      }),
    ).toEqual({ error: "The evaluator must be a JSON object.", ok: false });
  });
});
