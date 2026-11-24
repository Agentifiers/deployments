import { describe, expect, test } from "bun:test";
import { formatBudgetUsd, parseUsdAmount, percentUsed, usdInputValue } from "./budget-amount.ts";

describe("parseUsdAmount", () => {
  test("reads dollars into exact integer micros", () => {
    expect(parseUsdAmount("500")).toEqual({ ok: true, value: 500_000_000 });
    expect(parseUsdAmount(" $1,234.5 ")).toEqual({ ok: true, value: 1_234_500_000 });
    expect(parseUsdAmount("0.000001")).toEqual({ ok: true, value: 1 });
    expect(parseUsdAmount("0.1")).toEqual({ ok: true, value: 100_000 });
    expect(parseUsdAmount("9007199254.740991")).toEqual({ ok: true, value: 9_007_199_254_740_991 });
  });

  test("names what is wrong with an amount the API would reject", () => {
    expect(parseUsdAmount("9007199254.740992")).toEqual({
      message: "The amount is too large",
      ok: false,
    });
    expect(parseUsdAmount("0")).toEqual({
      message: "The amount must be greater than zero",
      ok: false,
    });
    expect(parseUsdAmount("0.0000001")).toEqual({
      message: "Use at most 6 decimal places (one micro-dollar)",
      ok: false,
    });
    expect(parseUsdAmount("12.3456789")).toEqual({
      message: "Use at most 6 decimal places (one micro-dollar)",
      ok: false,
    });
    for (const text of ["1e3", "-5", "", "$", "1.", ".5", "1 000"]) {
      expect({ text, parsed: parseUsdAmount(text) }).toEqual({
        parsed: { message: "Enter an amount in US dollars, such as 250 or 0.50", ok: false },
        text,
      });
    }
  });

  test("reads commas only as thousands groups before the point", () => {
    expect(parseUsdAmount("1,000.50")).toEqual({ ok: true, value: 1_000_500_000 });
    expect(parseUsdAmount("12,345,678")).toEqual({ ok: true, value: 12_345_678_000_000 });
    for (const text of ["250,50", "1.000,50", "0.000,001", "1,,0", "0,100", ",100", "1,0000"]) {
      expect({ text, parsed: parseUsdAmount(text) }).toEqual({
        parsed: {
          message: "Use a period for cents and commas only between thousands, as in 1,000.50",
          ok: false,
        },
        text,
      });
    }
  });
});

test("formatBudgetUsd shows every micro with two to six decimals", () => {
  expect(formatBudgetUsd(1)).toBe("$0.000001");
  expect(formatBudgetUsd(0)).toBe("$0.00");
  expect(formatBudgetUsd(500_000_000)).toBe("$500.00");
  expect(formatBudgetUsd(12_345_678)).toBe("$12.345678");
  expect(formatBudgetUsd(1_234_500_000)).toBe("$1,234.50");
  expect(formatBudgetUsd(9_007_199_254_740_991)).toBe("$9,007,199,254.740991");
});

test("usdInputValue round-trips through parseUsdAmount", () => {
  expect(usdInputValue(12_500_000)).toBe("12.5");
  expect(usdInputValue(1)).toBe("0.000001");
  expect(usdInputValue(1_000_000_000)).toBe("1000");
  expect(parseUsdAmount(usdInputValue(9_007_199_254_740_991))).toEqual({
    ok: true,
    value: 9_007_199_254_740_991,
  });
});

test("percentUsed floors like the refusal detail", () => {
  expect(percentUsed(1_250_000, 1_000_000)).toBe(125);
  expect(percentUsed(999_999, 1_000_000)).toBe(99);
  expect(percentUsed(5, 1)).toBe(500);
  expect(percentUsed(0, 1)).toBe(0);
  expect(percentUsed(9_007_199_254_740_991, 9_007_199_254_740_991)).toBe(100);
});
