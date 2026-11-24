import { describe, expect, test } from "bun:test";
import { ledgerCsv, ledgerCsvFilename, ledgerRows } from "./export.ts";
import type { LedgerUsage } from "./ledger.ts";

const usage: LedgerUsage = {
  buckets: ["2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z", "2026-10-01T02:00:00.000Z"],
  series: [
    {
      id: "quantity/model_tokens//tokens",
      kind: "quantity",
      metric: "model_tokens",
      total: 1_250,
      unit: "tokens",
      values: [1_000, 0, 250],
    },
    {
      id: "cost/model_tokens//usd_nanodollars",
      kind: "cost",
      metric: "model_tokens",
      total: 1_234_567,
      unit: "usd_nanodollars",
      values: [1_000_000, 0, 234_567],
    },
    {
      id: "quantity/custom,metric//widgets",
      kind: "quantity",
      metric: 'custom,"metric"',
      total: 0,
      unit: "widgets",
      values: [0, 0, 0],
    },
  ],
};

describe("ledger export", () => {
  test("rows skip buckets without usage and keep series order", () => {
    expect(ledgerRows(usage)).toEqual([
      { bucket: "2026-10-01T00:00:00.000Z", values: [1_000, 1_000_000, 0] },
      { bucket: "2026-10-01T02:00:00.000Z", values: [250, 234_567, 0] },
    ]);
  });

  test("CSV carries the table rows, a total row, USD to six decimals, and quoted headers", () => {
    expect(ledgerCsv(usage).split("\r\n")).toEqual([
      'bucket_start_utc,Model tokens (tokens),Model cost (USD),"custom,""metric"" (widgets)"',
      "2026-10-01T00:00:00.000Z,1000,0.001000,0",
      "2026-10-01T02:00:00.000Z,250,0.000235,0",
      "total,1250,0.001235,0",
      "",
    ]);
  });

  test("the filename names the range and its UTC window", () => {
    expect(ledgerCsvFilename("7d", "2026-09-26T16:00:00.000Z", "2026-10-03T16:00:00.000Z")).toBe(
      "usage-7d-20260926T1600Z-20261003T1600Z.csv",
    );
  });
});
