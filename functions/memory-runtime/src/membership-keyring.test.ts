import { describe, expect, it } from "bun:test";
import { ids } from "../../../packages/memory/src/test-fixtures.ts";
import {
  currentMemoryMembershipDigest,
  decodeMemoryMembershipKeyring,
  memoryMembershipDigests,
} from "./membership-keyring.ts";
import { createMemoryMembershipKeyringLoader } from "./membership-keyring-secret.ts";

describe("memory membership keyring", () => {
  it("retains historical digest versions while selecting the current key", () => {
    const keyring = decodeMemoryMembershipKeyring(
      JSON.stringify({
        currentVersion: 2,
        keys: { 1: "a".repeat(32), 2: "b".repeat(32) },
      }),
    );

    expect(memoryMembershipDigests(keyring, ids.run).map(({ keyVersion }) => keyVersion)).toEqual([
      2, 1,
    ]);
    expect(currentMemoryMembershipDigest(keyring, ids.run)).toMatchObject({ keyVersion: 2 });
    expect(() => decodeMemoryMembershipKeyring("legacy-raw-key")).toThrow("versioned JSON");
    expect(() =>
      decodeMemoryMembershipKeyring(
        JSON.stringify({ currentVersion: 2, keys: { 1: "a".repeat(32) } }),
      ),
    ).toThrow("current key");
  });

  it("refreshes current and historical digests after the bounded cache expires", async () => {
    let now = 0;
    let secret = JSON.stringify({ currentVersion: 1, keys: { 1: "a".repeat(32) } });
    let reads = 0;
    const loader = createMemoryMembershipKeyringLoader({
      now: () => now,
      readSecret: async () => {
        reads += 1;
        return secret;
      },
      ttlMs: 300_000,
    });

    await loader.load();
    secret = JSON.stringify({
      currentVersion: 2,
      keys: { 1: "a".repeat(32), 2: "b".repeat(32) },
    });
    now = 299_999;
    expect((await loader.load()).currentVersion).toBe(1);
    expect(reads).toBe(1);

    now = 300_000;
    const rotated = await loader.load();
    expect(currentMemoryMembershipDigest(rotated, ids.run).keyVersion).toBe(2);
    expect(memoryMembershipDigests(rotated, ids.run).map(({ keyVersion }) => keyVersion)).toEqual([
      2, 1,
    ]);
    expect(reads).toBe(2);
  });
});
