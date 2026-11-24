import { describe, expect, test } from "bun:test";
import { signThreadStreamSessionToken, verifyThreadStreamSessionToken } from "./session-tokens.ts";

const claims = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  expiresAt: "2026-07-23T13:00:00.000Z",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  permissions: ["read"] as const,
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
};
const options = {
  audience: "deployments-api",
  issuer: "deployments-ai-platform",
  secret: "0123456789abcdef0123456789abcdef",
};

describe("thread stream session tokens", () => {
  test("round trips scoped, expiring claims", () => {
    const token = signThreadStreamSessionToken(claims, options);
    expect(
      verifyThreadStreamSessionToken(token, {
        ...options,
        now: Date.parse("2026-07-23T12:00:00Z"),
      }),
    ).toEqual(claims);
  });

  test("rejects tampering, wrong audiences, and expired claims", () => {
    const token = signThreadStreamSessionToken(claims, options);
    expect(() => verifyThreadStreamSessionToken(`${token}x`, options)).toThrow("signature");
    expect(() => verifyThreadStreamSessionToken(token, { ...options, audience: "other" })).toThrow(
      "audience",
    );
    expect(() =>
      verifyThreadStreamSessionToken(token, {
        ...options,
        now: Date.parse("2026-07-23T13:00:00.000Z"),
      }),
    ).toThrow("expired");
  });
});
