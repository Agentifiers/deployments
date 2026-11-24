import {
  type IdentityRepository,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { enforceIdentityRateLimits } from "./rate-limits.ts";

describe("identity rate limits", () => {
  test("durably bounds email and source requests in exact expiring windows", async () => {
    const records = new Map<string, Extract<PlatformRecord, { itemType: "identity-rate-limit" }>>();
    const repository = {
      rateLimit: (limitKey: string, scopeHash: string, window: string) =>
        Promise.resolve(records.get(`${limitKey}\u0000${scopeHash}\u0000${window}`)),
      transact: async (operations: readonly TransactionOperation[]) => {
        for (const operation of operations) {
          if (operation.kind === "put" && operation.record.itemType === "identity-rate-limit") {
            const data = operation.record.data;
            records.set(
              `${data.limitKey}\u0000${data.scopeHash}\u0000${data.window}`,
              operation.record,
            );
          }
        }
      },
    } as unknown as IdentityRepository;
    const request = () =>
      enforceIdentityRateLimits({
        emailHash: "email-hash",
        emailPolicy: { limit: 2, windowSeconds: 60 },
        limitKey: "sign-up",
        now: new Date("2026-07-28T00:00:30.000Z"),
        repository,
        sourceHash: "source-hash",
        sourcePolicy: { limit: 2, windowSeconds: 60 },
      });

    expect(request()).resolves.toBeUndefined();
    expect(request()).resolves.toBeUndefined();
    expect(request()).rejects.toMatchObject({ code: "slow_down", status: 429 });
    expect([...records.values()]).toHaveLength(2);
    expect([...records.values()].map((record) => record.data.count)).toEqual([2, 2]);
    expect(
      [...records.values()].every(
        (record) => record.ttl === Math.floor(Date.parse("2026-07-28T00:01:00.000Z") / 1_000),
      ),
    ).toBe(true);
  });

  test("does not consume the same public request again after a partial failure", async () => {
    const records = new Map<string, Extract<PlatformRecord, { itemType: "identity-rate-limit" }>>();
    let failEmailWrite = true;
    const repository = {
      rateLimit: (limitKey: string, scopeHash: string, window: string) =>
        Promise.resolve(records.get(`${limitKey}\u0000${scopeHash}\u0000${window}`)),
      transact: async (operations: readonly TransactionOperation[]) => {
        const write = operations.find(
          (operation) =>
            operation.kind === "put" && operation.record.itemType === "identity-rate-limit",
        );
        if (write?.kind !== "put" || write.record.itemType !== "identity-rate-limit") return;
        if (write.record.data.limitKey === "sign-up:email" && failEmailWrite) {
          failEmailWrite = false;
          throw new Error("Email counter write failed after the source counter committed.");
        }
        const data = write.record.data;
        records.set(`${data.limitKey}\u0000${data.scopeHash}\u0000${data.window}`, write.record);
      },
    } as unknown as IdentityRepository;
    const request = {
      emailHash: "email-hash",
      emailPolicy: { limit: 2, windowSeconds: 60 },
      limitKey: "sign-up" as const,
      now: new Date("2026-07-28T00:00:30.000Z"),
      repository,
      requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
      sourceHash: "source-hash",
      sourcePolicy: { limit: 2, windowSeconds: 60 },
    };

    expect(enforceIdentityRateLimits(request)).rejects.toThrow(
      "Email counter write failed after the source counter committed.",
    );
    expect(enforceIdentityRateLimits(request)).resolves.toBeUndefined();

    expect([...records.values()].map((record) => record.data.count)).toEqual([1, 1]);
  });
});
