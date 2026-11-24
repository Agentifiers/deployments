import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CreateObservabilityExportRequest,
  ObservabilityExportResponse,
  ObservabilityMetricSeriesResponse,
  ObservabilityTraceResponse,
} from "./observability.ts";

test("constrains synchronous observability export limits", () => {
  const decode = Schema.decodeUnknownSync(CreateObservabilityExportRequest);
  expect(decode({})).toEqual({});
  expect(decode({ limit: 1_000 })).toEqual({ limit: 1_000 });
  for (const limit of [0, 1.5, 1_001]) {
    expect(() => decode({ limit })).toThrow();
  }
});

test("requires canonical UTC timestamps in observability responses", () => {
  const trace = {
    environment_id: "environment",
    fact_id: "fact",
    occurred_at: "2026-08-03T00:00:00.000Z",
    project_id: "project",
    trace_id: "trace",
  };
  expect(Schema.decodeUnknownSync(ObservabilityTraceResponse)(trace)).toEqual(trace);
  expect(() =>
    Schema.decodeUnknownSync(ObservabilityTraceResponse)({
      ...trace,
      occurred_at: "2026-08-03 00:00:00.000",
    }),
  ).toThrow();
  expect(
    Schema.decodeUnknownSync(ObservabilityMetricSeriesResponse)({
      from: "2026-08-02T00:00:00.000Z",
      interval: "hour",
      items: [
        {
          bucket: "2026-08-03T00:00:00.000Z",
          error_count: 0,
          total_cost_usd_micros: 7,
          total_tokens: 12,
          trace_count: 1,
        },
      ],
      source: "traces",
      to: "2026-08-03T00:00:00.000Z",
    }),
  ).toBeDefined();
  expect(() =>
    Schema.decodeUnknownSync(ObservabilityMetricSeriesResponse)({
      from: "2026-08-02T00:00:00.000Z",
      interval: "week",
      items: [],
      source: "traces",
      to: "2026-08-03T00:00:00.000Z",
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ObservabilityExportResponse)({
      generatedAt: "2026-08-03 00:00:00.000",
      items: [],
    }),
  ).toThrow();
});
