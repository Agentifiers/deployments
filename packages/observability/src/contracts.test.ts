import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  SpanId,
  TraceId,
  evaluateTraceCompletion,
  makeObservabilityFact,
  metadataOnlyAttributes,
  parseObservabilityFact,
  stableSpanId,
} from "./index.ts";

const traceId = Schema.decodeUnknownSync(TraceId)("0123456789abcdef0123456789abcdef");

describe("observability contracts", () => {
  test("enforces W3C identifiers and derives stable non-zero span identities", () => {
    expect(() => Schema.decodeUnknownSync(TraceId)("0".repeat(32))).toThrow();
    expect(() => Schema.decodeUnknownSync(SpanId)("ABCDEF0123456789")).toThrow();
    expect(stableSpanId(traceId, "run:01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(
      stableSpanId(traceId, "run:01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    );
  });

  test("creates deterministic fact IDs from the source contract", () => {
    const input = {
      captureMode: "metadata-only" as const,
      factType: "span.finalized" as const,
      normalizedAt: "2026-07-28T12:00:01.000Z",
      occurredAt: "2026-07-28T12:00:00.000Z",
      payload: { status: "ok" },
      scope: { environmentId: "env", organizationId: "org", projectId: "project" },
      source: {
        recordId: "run",
        recordType: "run",
        recordVersion: 2,
        table: "execution" as const,
      },
      trace: {
        runId: "run",
        sessionId: "thread",
        spanId: stableSpanId(traceId, "run"),
        traceId,
      },
    };
    expect(makeObservabilityFact(input).factId).toBe(makeObservabilityFact(input).factId);
    expect(
      makeObservabilityFact({
        ...input,
        source: { ...input.source, streamSequenceNumber: "100" },
      }).factId,
    ).toBe(
      makeObservabilityFact({
        ...input,
        source: { ...input.source, streamSequenceNumber: "200" },
      }).factId,
    );
  });

  test("allows a deletion tombstone after its trace context has expired", () => {
    const fact = makeObservabilityFact({
      captureMode: "metadata-only",
      factType: "record.deleted",
      normalizedAt: "2026-07-28T12:00:01.000Z",
      occurredAt: "2026-07-28T12:00:01.000Z",
      payload: { deleteThroughRecordVersion: 2, deletedFactTypes: ["span.finalized"] },
      scope: { environmentId: "env", organizationId: "org", projectId: "project" },
      source: {
        recordId: "run",
        recordType: "tool-call",
        recordVersion: 2,
        streamArn: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
        streamSequenceNumber: "100",
        table: "execution",
      },
    });

    expect(fact.trace).toBeUndefined();
    expect(fact.factType).toBe("record.deleted");
  });

  test("removes sensitive body fields in metadata-only mode", () => {
    expect(
      metadataOnlyAttributes({
        durationMs: 12,
        inputTokens: 5,
        output: "patient data",
        outputTokens: 7,
        requestBody: "patient data",
        requestedModelId: "openrouter/primary",
        safeNested: {
          durationMs: 3,
          environmentVariables: { DATABASE_URL: "postgres://secret" },
          requestBody: "nested patient data",
        },
        status: "ok",
        totalTokens: 12,
        accessToken: "provider-secret",
      }),
    ).toEqual({
      durationMs: 12,
      inputTokens: 5,
      outputTokens: 7,
      requestedModelId: "openrouter/primary",
      safeNested: { durationMs: 3 },
      status: "ok",
      totalTokens: 12,
    });
  });

  test("requires fact payloads to be objects", () => {
    const fact = makeObservabilityFact({
      captureMode: "metadata-only",
      factType: "span.finalized",
      normalizedAt: "2026-07-28T12:00:01.000Z",
      occurredAt: "2026-07-28T12:00:00.000Z",
      payload: { status: "ok" },
      scope: { environmentId: "env", organizationId: "org", projectId: "project" },
      source: {
        recordId: "run",
        recordType: "run",
        recordVersion: 2,
        table: "execution",
      },
    });

    expect(() =>
      parseObservabilityFact({ ...fact, payload: [{ requestBody: "patient data" }] }),
    ).toThrow();
  });

  test("finalizes child, retry, fallback, approval, canceled, evaluator, and replay fixtures", () => {
    const runs = [
      { id: "root", status: "completed", traceId, version: 3 },
      { id: "child", status: "canceled", traceId, version: 2 },
    ];
    const edges = [{ childRunId: "child", parentRunId: "root", traceId, version: 0 }];
    const complete = evaluateTraceCompletion({ edges, rootRunId: "root", runs, traceId });
    expect(complete.complete).toBe(true);
    expect(complete.runIds).toEqual(["child", "root"]);
    expect(
      evaluateTraceCompletion({
        edges,
        rootRunId: "root",
        runs: [{ ...runs[0]!, status: "running" }, runs[1]!],
        traceId,
      }).pendingRunIds,
    ).toEqual(["root"]);
    expect(complete.graphWatermark).toBe(
      evaluateTraceCompletion({ edges: [...edges], rootRunId: "root", runs: [...runs], traceId })
        .graphWatermark,
    );
  });
});
