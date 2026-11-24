import { expect, test } from "bun:test";
import { Schema } from "effect";
import { withCanonicalRecordKeys } from "./index.ts";
import { TraceRecord } from "./observability.ts";

const ROOT_RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const finalized = {
  agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
  agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  agentReleaseId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
  captureMode: "metadata-only",
  completedAt: "2026-07-22T00:00:02.000Z",
  createdAt: "2026-07-22T00:00:00.000Z",
  durationMs: 2_000,
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
  errorClass: "RateLimitError",
  executionPurpose: "customer",
  finalizedAt: "2026-07-22T00:00:03.000Z",
  id: "0123456789abcdef0123456789abcdef",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  outcome: "error",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
  redactionPolicyVersion: 1,
  releaseSelection: "primary",
  rootRunId: ROOT_RUN,
  rootSpanId: "0123456789abcdef",
  runIds: [ROOT_RUN],
  schemaVersion: 1,
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
  status: "finalized",
  traceId: "0123456789abcdef0123456789abcdef",
  trigger: "api",
  updatedAt: "2026-07-22T00:00:03.000Z",
  version: 1,
} as const;

const decode = (data: Readonly<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(TraceRecord)(withCanonicalRecordKeys({ data, itemType: "trace" }));

test("trace outcome summary fields exist only on finalized traces and errors", () => {
  expect(decode(finalized).data).toMatchObject({ durationMs: 2_000, errorClass: "RateLimitError" });
  expect(() => decode({ ...finalized, outcome: "ok" })).toThrow(
    "Trace errorClass exists only when the trace outcome is error.",
  );
  const {
    completedAt: _completedAt,
    errorClass: _errorClass,
    finalizedAt: _finalizedAt,
    outcome: _outcome,
    ...open
  } = finalized;
  expect(() => decode({ ...open, status: "open" })).toThrow(
    "Trace durationMs and errorClass exist only on finalized traces.",
  );
  // Agent identity is stable root-run data and survives reopening.
  const { durationMs: _durationMs, ...reopened } = open;
  expect(decode({ ...reopened, status: "open" }).data).toMatchObject({
    agentDeploymentId: finalized.agentDeploymentId,
  });
});
