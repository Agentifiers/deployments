import type {
  AddDatasetCaseRequest,
  AnnotationResponse,
  CreateRegressionDatasetRequest,
  CreateScoreDefinitionRequest,
  DatasetCaseResponse,
  EvaluationCaseResultResponse,
  EvaluationRunResponse,
  ImportDatasetCasesRequest,
  RegressionDatasetResponse,
  ReleaseComparisonResponse,
  ReviseScoreDefinitionRequest,
  ScoreDefinitionResponse,
  ScoreResultResponse,
} from "@deployments-ai/api-contract";
import type { PublicId } from "@deployments-ai/api-contract/primitives";
import { PlatformRequestError } from "./index.ts";
import { ULID_ALPHABET } from "./tenancy-mock.ts";

export interface EvaluationMockState {
  readonly annotations: AnnotationResponse[];
  readonly cases: Map<string, DatasetCaseResponse[]>;
  readonly comparisons: Map<string, ReleaseComparisonResponse>;
  readonly datasets: Map<string, RegressionDatasetResponse>;
  readonly idempotencyResults: Map<
    string,
    { readonly data: unknown; readonly fingerprint: string }
  >;
  readonly runResults: Map<string, EvaluationCaseResultResponse[]>;
  readonly runs: Map<string, EvaluationRunResponse>;
  readonly scoreDefinitions: Map<string, ScoreDefinitionResponse>;
  readonly scoreResults: ScoreResultResponse[];
  nextId: number;
}

export type EvaluationMockResult =
  | { readonly matched: false }
  | { readonly data: unknown; readonly matched: true };

const MOCK_ID_PREFIX = "01J9MXEVQ0000000000000";
export const MOCK_OWNER = "principal_mock";
/** SHA-256 of the empty string: a stable, well-formed placeholder digest. */
const MOCK_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SEED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const IMPORTED_EXPECTATION_KINDS: Readonly<Record<string, string>> = {
  jsonSchema: "jsonSchema",
  matches: "matches",
  mustInclude: "mustInclude",
  mustNot: "mustNot",
  mustNotUseTools: "mustNotUseTools",
  mustUseTools: "mustUseTools",
};
const IMPORTED_CASE_FIELDS: Readonly<Record<string, true>> = {
  consentBasis: true,
  expected: true,
  id: true,
  message: true,
  tags: true,
};

export function nextId(state: EvaluationMockState) {
  let value = state.nextId++;
  let suffix = "";
  for (let index = 0; index < 4; index += 1) {
    suffix = ULID_ALPHABET[value % ULID_ALPHABET.length]! + suffix;
    value = Math.floor(value / ULID_ALPHABET.length);
  }
  return `${MOCK_ID_PREFIX}${suffix}` as PublicId;
}

export function nextTraceId(state: EvaluationMockState) {
  return (state.nextId++).toString(16).padStart(32, "0");
}

export function createEvaluationMockState(): EvaluationMockState {
  const state: EvaluationMockState = {
    annotations: [],
    cases: new Map(),
    comparisons: new Map(),
    datasets: new Map(),
    idempotencyResults: new Map(),
    nextId: 1,
    runResults: new Map(),
    runs: new Map(),
    scoreDefinitions: new Map(),
    scoreResults: [],
  };
  createScoreDefinition(state, SEED_TIMESTAMP, {
    description: "Responses mention the requested order number.",
    evaluator: { kind: "contains", values: ["order"] },
    name: "mentions-order",
  });
  const dataset = createDataset(state, SEED_TIMESTAMP, {
    description: "Customer support regressions.",
    name: "support-regressions",
  });
  addCase(state, SEED_TIMESTAMP, dataset.id, {
    expectations: { mustInclude: ["order"] },
    externalId: "refund-status",
    input: { content: "Where is my refund for order 1042?" },
    tags: ["refunds"],
  });
  addCase(state, SEED_TIMESTAMP, dataset.id, {
    expectations: { mustNotUseTools: ["payments.charge"] },
    externalId: "no-charge",
    input: { content: "Cancel my subscription without charging me." },
    tags: ["billing"],
  });
  return state;
}

export function scoreType(kind: CreateScoreDefinitionRequest["evaluator"]["kind"]) {
  if (kind === "human" || kind === "imported") return kind;
  return kind === "model_judge" ? "model-judged" : "deterministic";
}

export function definitionRevision(
  now: string,
  input: CreateScoreDefinitionRequest | ReviseScoreDefinitionRequest,
  revision: number,
): ScoreDefinitionResponse["revision"] {
  return {
    createdAt: now,
    evaluator: input.evaluator,
    evaluatorVersionHash: MOCK_SHA256,
    ...(input.evaluator.kind === "model_judge"
      ? { judgeModelId: input.evaluator.modelId, judgePromptHash: MOCK_SHA256 }
      : {}),
    revision,
    sampling: input.sampling ?? { rate: 0 },
    status: "active",
    target: input.target ?? "root-run",
    threshold: input.threshold ?? 1,
    ...(input.weight === undefined ? {} : { weight: input.weight }),
  };
}

export function createScoreDefinition(
  state: EvaluationMockState,
  now: string,
  input: CreateScoreDefinitionRequest,
) {
  const definition: ScoreDefinitionResponse = {
    createdAt: now,
    currentRevision: 1,
    ...(input.description === undefined ? {} : { description: input.description }),
    id: nextId(state),
    name: input.name,
    ownerPrincipalId: MOCK_OWNER,
    revision: definitionRevision(now, input, 1),
    status: "active",
    type: scoreType(input.evaluator.kind),
    updatedAt: now,
    version: 0,
  };
  state.scoreDefinitions.set(definition.id, definition);
  return definition;
}

export function createDataset(
  state: EvaluationMockState,
  now: string,
  input: CreateRegressionDatasetRequest,
) {
  const dataset: RegressionDatasetResponse = {
    caseCount: 0,
    createdAt: now,
    ...(input.description === undefined ? {} : { description: input.description }),
    id: nextId(state),
    name: input.name,
    ownerPrincipalId: MOCK_OWNER,
    ...(input.retentionDays === undefined ? {} : { retentionDays: input.retentionDays }),
    status: "active",
    updatedAt: now,
    version: 0,
  };
  state.datasets.set(dataset.id, dataset);
  state.cases.set(dataset.id, []);
  return dataset;
}

export function found<T>(map: ReadonlyMap<string, T>, id: string, label: string): T {
  const value = map.get(id);
  if (!value) throw new PlatformRequestError(`${label} ${id} was not found.`);
  return value;
}

export function activeDataset(state: EvaluationMockState, id: string) {
  const dataset = found(state.datasets, id, "Regression dataset");
  if (dataset.status !== "active") {
    throw new PlatformRequestError(`Regression dataset ${id} is archived.`);
  }
  return dataset;
}

function storeCase(
  state: EvaluationMockState,
  now: string,
  datasetId: PublicId,
  fields: Omit<DatasetCaseResponse, "contentSha256" | "createdAt" | "datasetId" | "id">,
) {
  const dataset = activeDataset(state, datasetId);
  const cases = state.cases.get(datasetId)!;
  const existing = cases.find((candidate) =>
    fields.externalId === undefined
      ? candidate.inputPreview === fields.inputPreview
      : candidate.externalId === fields.externalId,
  );
  if (existing) return { case: existing, created: false };
  const stored: DatasetCaseResponse = {
    ...fields,
    contentSha256: MOCK_SHA256,
    createdAt: now,
    datasetId,
    id: nextId(state),
  };
  cases.push(stored);
  state.datasets.set(datasetId, {
    ...dataset,
    caseCount: cases.length,
    updatedAt: now,
    version: dataset.version + 1,
  });
  return { case: stored, created: true };
}

export function addCase(
  state: EvaluationMockState,
  now: string,
  datasetId: PublicId,
  input: AddDatasetCaseRequest,
) {
  const inputPreview = input.input
    ? input.input.content.slice(0, 200)
    : input.source?.type === "trace"
      ? `Root run input of trace ${input.source.traceId}`
      : `User input of run ${input.source?.runId}`;
  return storeCase(state, now, datasetId, {
    ...(input.consentBasis === undefined ? {} : { consentBasis: input.consentBasis }),
    expectationKinds: Object.keys(input.expectations ?? {}).sort(),
    ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
    inputPreview,
    provenance: input.source ? "trace" : "manual",
    ...(input.source?.type === "run"
      ? { sourceRunId: input.source.runId, sourceThreadId: input.source.threadId }
      : {}),
    ...(input.source?.type === "trace" ? { sourceTraceId: input.source.traceId } : {}),
    tags: [...(input.tags ?? [])],
  });
}

export function importCases(
  state: EvaluationMockState,
  now: string,
  datasetId: PublicId,
  input: ImportDatasetCasesRequest,
) {
  const items = input.cases.map((entry) => {
    const kinds = new Set<string>();
    for (const key of Object.keys(entry.expected ?? {})) {
      kinds.add(IMPORTED_EXPECTATION_KINDS[key] ?? "constraints");
    }
    if (Object.keys(entry).some((key) => !IMPORTED_CASE_FIELDS[key])) kinds.add("constraints");
    const result = storeCase(state, now, datasetId, {
      ...(entry.consentBasis === undefined ? {} : { consentBasis: entry.consentBasis }),
      expectationKinds: [...kinds].sort(),
      ...(entry.id === undefined ? {} : { externalId: entry.id }),
      inputPreview: entry.message.slice(0, 200),
      provenance: "import",
      tags: [...(entry.tags ?? [])],
    });
    return { ...result, ...(entry.id === undefined ? {} : { externalId: entry.id }) };
  });
  const created = items.filter((item) => item.created).length;
  return { created, existing: items.length - created, items };
}
