import { expect, test } from "bun:test";
import { parseClickHouseJsonRows } from "./clickhouse.ts";

test("normalizes nullable ClickHouse columns out of public rows", () => {
  expect(parseClickHouseJsonRows('{"fact_id":"fact-1","run_id":null,"run_count":2}\n')).toEqual([
    { fact_id: "fact-1", run_count: 2 },
  ]);
});

test("rejects non-object JSONEachRow output", () => {
  expect(() => parseClickHouseJsonRows("null\n")).toThrow(
    "ClickHouse returned a non-object JSONEachRow value.",
  );
});
