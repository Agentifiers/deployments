import { describe, expect, test } from "bun:test";
import { isNotFound } from "@tanstack/react-router";
import { PlatformApiError, UnauthenticatedError } from "../errors.ts";
import { notFoundUnlessSignedOut } from "./admission.ts";

async function outcome(error: unknown, probe: () => Promise<unknown>) {
  return notFoundUnlessSignedOut(error, probe).catch((thrown: unknown) => thrown);
}

describe("notFoundUnlessSignedOut", () => {
  test("turns a scoped 401 into Not found when the session still works", async () => {
    const thrown = await outcome(new UnauthenticatedError(), () => Promise.resolve([]));
    expect(isNotFound(thrown)).toBe(true);
  });

  test("keeps the sign-in error when the session is gone", async () => {
    const original = new UnauthenticatedError("scoped");
    const thrown = await outcome(original, () => Promise.reject(new UnauthenticatedError("probe")));
    expect(thrown).toBe(original);
  });

  test("rethrows other failures without probing", async () => {
    const forbidden = new PlatformApiError("getOrganization", { status: 403, title: "Forbidden" });
    let probes = 0;
    const thrown = await outcome(forbidden, () => {
      probes += 1;
      return Promise.resolve([]);
    });
    expect({ probes, thrown }).toEqual({ probes: 0, thrown: forbidden });
  });
});
