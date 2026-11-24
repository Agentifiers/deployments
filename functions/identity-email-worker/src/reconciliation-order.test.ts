import { describe, expect, test } from "bun:test";
import {
  RECONCILIATION_PER_SHARD_LIMIT,
  reconciliationShardOrder,
} from "./reconciliation-order.ts";

describe("identity email reconciliation fairness", () => {
  test("rotates the first shard every minute and bounds each shard", () => {
    const first = reconciliationShardOrder(new Date("2026-07-28T00:00:00.000Z"));
    const second = reconciliationShardOrder(new Date("2026-07-28T00:01:00.000Z"));

    expect(first).toHaveLength(16);
    expect(new Set(first).size).toBe(16);
    expect(second[0]).toBe((first[0]! + 1) % 16);
    expect(RECONCILIATION_PER_SHARD_LIMIT).toBe(32);
  });
});
