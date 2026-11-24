import { describe, expect, test } from "bun:test";
import { platformJwtClaims } from "./platform-jwt.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1";

describe("platform JWT token session", () => {
  test("reads the sid claim as the token session id", () => {
    expect(
      platformJwtClaims({ scope: "projects:read", sid: SESSION_ID, sub: PRINCIPAL_ID }, "platform"),
    ).toEqual({
      principalId: PRINCIPAL_ID,
      scopes: ["projects:read"],
      tokenSessionId: SESSION_ID,
    });
  });

  test("accepts the token without a session id when sid is absent or malformed", () => {
    const claims = (sid: unknown) =>
      platformJwtClaims({ scope: "projects:read", sid, sub: PRINCIPAL_ID }, "platform");
    const expected = { principalId: PRINCIPAL_ID, scopes: ["projects:read"] };
    expect(claims(undefined)).toEqual(expected);
    expect(claims("not-a-session")).toEqual(expected);
    expect(claims(42)).toEqual(expected);
  });

  test("reports a verified email only when the issuer signed email_verified true", () => {
    expect(
      [true, false, "true", undefined].map(
        (emailVerified) =>
          platformJwtClaims(
            { email_verified: emailVerified, scope: "projects:read", sub: PRINCIPAL_ID },
            "platform",
          )?.emailVerified,
      ),
    ).toEqual([true, undefined, undefined, undefined]);
  });
});
