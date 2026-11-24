import { describe, expect, it } from "bun:test";
import {
  bffFenceRecord,
  makeIdGenerator,
  passwordCredentialRecord,
  principalRecord,
  securityStateRecord,
  Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  type OperatorIdentityChange,
  operatorIdentityChange,
  operatorIdentityOperations,
  type OperatorIdentityState,
} from "./identity-plan.ts";

const principalId = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const createdAt = "2026-07-30T00:00:00.000Z";
const now = "2026-07-30T01:00:00.000Z";
const ids = makeIdGenerator();

const principal = principalRecord({
  createdAt,
  id: principalId,
  platformRole: "administrator",
  primaryEmail: "ops@example.com",
  version: 4,
});
const existing: OperatorIdentityState = {
  credential: passwordCredentialRecord({
    createdAt,
    passwordHash: "old-hash",
    principalId,
    version: 3,
  }),
  fence: bffFenceRecord({
    createdAt,
    principalId,
    principalStatus: "active",
    sessionEpoch: 7,
    version: 5,
  }),
  principal,
  principalId,
  security: securityStateRecord({
    createdAt,
    credentialVersion: 3,
    emailVerifiedAt: createdAt,
    principalId,
    sessionEpoch: 7,
    version: 5,
  }),
};
const absent: OperatorIdentityState = {
  credential: undefined,
  fence: undefined,
  principal: undefined,
  principalId,
  security: undefined,
};

function operations(change: OperatorIdentityChange) {
  if (change.kind === "unchanged") throw new Error("expected a write");
  return operatorIdentityOperations({
    change,
    generateId: () => ids.generate(),
    now,
    passwordHash: "new-hash",
    principalId,
    username: "ops@example.com",
  });
}

describe("operator identity change", () => {
  it("creates the administrator, login material, email claim, and events atomically", () => {
    const change = operatorIdentityChange({
      ...absent,
      rotate: false,
      storedPasswordMatches: false,
    });
    expect(change).toEqual({ kind: "create", principal: undefined });
    const written = operations(change).map((operation) =>
      operation.kind === "put"
        ? [
            operation.record.itemType,
            "eventType" in operation.record.data ? operation.record.data.eventType : undefined,
          ]
        : [operation.kind],
    );
    expect(written).toEqual([
      ["principal", undefined],
      ["principal-credential", undefined],
      ["principal-security-state", undefined],
      ["identity-bff-revocation-fence", undefined],
      ["unique-claim", undefined],
      ["identity-security-event", "identity.operator-login-enabled"],
      ["identity-security-event", "identity.credentials-created"],
    ]);
  });

  it("writes nothing when the stored password verifies", () => {
    expect(
      operatorIdentityChange({ ...existing, rotate: false, storedPasswordMatches: true }),
    ).toEqual({ kind: "unchanged" });
  });

  it("rotates when the password does not verify, advancing every version by exactly one", () => {
    const change = operatorIdentityChange({
      ...existing,
      rotate: false,
      storedPasswordMatches: false,
    });
    expect(change.kind).toBe("rotate");
    const puts = operations(change).filter((operation) => operation.kind === "put");
    expect(puts.map((operation) => operation.record.itemType)).toEqual([
      "principal-credential",
      "principal-security-state",
      "identity-bff-revocation-fence",
      "identity-security-event",
    ]);
    expect(puts[0]?.record.data).toMatchObject({ passwordHash: "new-hash", version: 4 });
    expect(puts[1]?.record.data).toMatchObject({
      credentialVersion: 4,
      sessionEpoch: 8,
      version: 6,
    });
    expect(puts[2]?.record.data).toMatchObject({ sessionEpoch: 8, version: 6 });
    expect(puts[3]?.record.data).toMatchObject({ eventType: "identity.credentials-rotated" });
  });

  it("rotates on request even when the password verifies", () => {
    expect(
      operatorIdentityChange({ ...existing, rotate: true, storedPasswordMatches: true }).kind,
    ).toBe("rotate");
  });

  it("does not silently elevate an existing non-administrator principal", () => {
    expect(() =>
      operatorIdentityChange({
        ...absent,
        principal: principalRecord({ createdAt, id: principalId, primaryEmail: "ops@example.com" }),
        rotate: false,
        storedPasswordMatches: false,
      }),
    ).toThrow("must be a platform administrator");
  });

  it("rejects partial login material and an epoch that disagrees with the fence", () => {
    expect(() =>
      operatorIdentityChange({
        ...existing,
        fence: undefined,
        rotate: false,
        storedPasswordMatches: true,
      }),
    ).toThrow("incomplete login material");
    expect(() =>
      operatorIdentityChange({
        ...existing,
        fence: bffFenceRecord({
          createdAt,
          principalId,
          principalStatus: "active",
          sessionEpoch: 6,
          version: 5,
        }),
        rotate: false,
        storedPasswordMatches: true,
      }),
    ).toThrow("does not match its principal");
  });
});
