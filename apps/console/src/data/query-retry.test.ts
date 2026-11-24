import { describe, expect, test } from "bun:test";
import { notFound } from "@tanstack/react-router";
import { PlatformApiError, UnauthenticatedError } from "../errors.ts";
import { shouldRetryQuery } from "./query-retry.ts";

describe("shouldRetryQuery", () => {
  test("never retries Not found, sign-in, or problem responses", () => {
    const finals = {
      notFound: notFound(),
      problem: new PlatformApiError("getEnvironment", { status: 404, title: "Not Found" }),
      unauthenticated: new UnauthenticatedError(),
    };
    expect(
      Object.fromEntries(
        Object.entries(finals).map(([name, error]) => [name, shouldRetryQuery(0, error)]),
      ),
    ).toEqual({ notFound: false, problem: false, unauthenticated: false });
  });

  test("retries a transient failure twice", () => {
    const transient = new TypeError("fetch failed");
    expect([0, 1, 2].map((failureCount) => shouldRetryQuery(failureCount, transient))).toEqual([
      true,
      true,
      false,
    ]);
  });
});
