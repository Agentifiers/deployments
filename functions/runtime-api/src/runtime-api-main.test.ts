import { describe, expect, test } from "bun:test";
import type { RuntimeApiDependencies } from "./runtime-support.ts";
import { cachedRuntimeApiHandler } from "./runtime-api-main.ts";

describe("runtime API dependency initialization", () => {
  test("retries after a rejected initialization promise", async () => {
    let attempts = 0;
    const dependencies = {} as RuntimeApiDependencies;
    const create = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("secret manager unavailable");
      return dependencies;
    };

    expect(cachedRuntimeApiHandler(create)).rejects.toThrow("secret manager unavailable");
    expect(cachedRuntimeApiHandler(create)).resolves.toBeFunction();
    expect(attempts).toBe(2);
  });
});
