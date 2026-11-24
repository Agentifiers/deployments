import { describe, expect, test } from "bun:test";
import { decodePublicResponse } from "./validation.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = "2026-10-01T00:00:00.000Z";
const item = {
  createdAt: NOW,
  credentialId: ID,
  generation: 2,
  ownerId: ID,
  ownerStatus: "active",
  ownerType: "provider-connection",
  purpose: "provider-api",
  status: "active",
  store: "dynamodb-kms",
  updatedAt: NOW,
};

describe("credential reference inventory contract", () => {
  test("rejects any secret material in an inventory page", () => {
    expect(
      decodePublicResponse("listCredentialReferences", { items: [item], nextCursor: null }),
    ).toEqual({ items: [item], nextCursor: null });
    for (const leak of [
      { ciphertext: "must-not-leak" },
      { value: "must-not-leak" },
      { encryptedDataKey: "must-not-leak" },
      { encryptionContextHash: "must-not-leak" },
      { secrets: { API_TOKEN: "must-not-leak" } },
    ]) {
      expect(() =>
        decodePublicResponse("listCredentialReferences", {
          items: [{ ...item, ...leak }],
          nextCursor: null,
        }),
      ).toThrow();
    }
  });
});
