import { describe, expect, it } from "bun:test";
import { decodeMemorySearchErasureReceipt } from "./governance-memory-search-erasure.ts";

const ids = {
  memory2: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
  run: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
  space: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  toolCall: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
} as const;

const validReceipt = {
  operationId: ids.toolCall,
  targets: [
    {
      componentReceipts: [
        {
          componentId: ids.space,
          generationId: ids.memory2,
          providerReceipt: { absenceVerified: true as const, receiptDigest: "proof" },
        },
      ],
      providerId: "aws-native" as const,
      targetDigest: "target-proof",
    },
  ],
};

describe("memory search erasure receipt validation", () => {
  it("requires the exact governance operation and component absence proofs", () => {
    const decoded = decodeMemorySearchErasureReceipt(validReceipt, ids.toolCall);
    expect(String(decoded.operationId)).toBe(ids.toolCall);
    expect(decoded.targets).toHaveLength(1);
    expect(() => decodeMemorySearchErasureReceipt({}, ids.toolCall)).toThrow();
    expect(() => decodeMemorySearchErasureReceipt(validReceipt, ids.run)).toThrow("does not match");
    expect(() =>
      decodeMemorySearchErasureReceipt(
        {
          ...validReceipt,
          targets: [{ ...validReceipt.targets[0], componentReceipts: [] }],
        },
        ids.toolCall,
      ),
    ).toThrow("no component absence proof");
    expect(() =>
      decodeMemorySearchErasureReceipt(
        {
          ...validReceipt,
          targets: [
            {
              ...validReceipt.targets[0],
              componentReceipts: [
                {
                  ...validReceipt.targets[0]!.componentReceipts[0],
                  providerReceipt: { absenceVerified: false, receiptDigest: "proof" },
                },
              ],
            },
          ],
        },
        ids.toolCall,
      ),
    ).toThrow();
  });

  it("keeps each target's canonical backup boundary", () => {
    const withBoundary = (backupErasureEligibleAt: string) => ({
      ...validReceipt,
      targets: [{ ...validReceipt.targets[0], backupErasureEligibleAt }],
    });

    expect(
      decodeMemorySearchErasureReceipt(withBoundary("2026-08-11T13:10:00.000Z"), ids.toolCall)
        .targets[0]?.backupErasureEligibleAt,
    ).toBe("2026-08-11T13:10:00.000Z");
    expect(() =>
      decodeMemorySearchErasureReceipt(withBoundary("2026-08-11 13:10"), ids.toolCall),
    ).toThrow();
  });
});
