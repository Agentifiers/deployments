import { describe, expect, test } from "bun:test";

import type { FederationHttpResponse } from "./http.ts";
import {
  USERINFO_URL,
  failureCode,
  jsonResponse,
  recordingHttp,
} from "./testing/fake-identity-provider.ts";
import { requestFederationUserinfo } from "./userinfo.ts";

function userinfo(response: FederationHttpResponse) {
  const idp = recordingHttp(() => response);
  const result = requestFederationUserinfo({
    bearerAccessToken: "at-1",
    endpoint: USERINFO_URL,
    http: idp.http,
    subject: "00u1federated",
  });
  return { requests: idp.requests, result };
}

describe("requestFederationUserinfo", () => {
  test("sends the Bearer token and returns the profile of the ID token's subject", async () => {
    const { requests, result } = userinfo(
      jsonResponse(200, {
        email: "ada@example.com",
        email_verified: true,
        hd: "example.com",
        name: "Ada Lovelace",
        sub: "00u1federated",
        xms_edov: true,
      }),
    );
    expect(await result).toStrictEqual({
      emailClaims: { email: "ada@example.com", emailVerified: true, hostedDomain: "example.com" },
      name: "Ada Lovelace",
    });
    expect(requests).toEqual([
      {
        headers: { accept: "application/json", authorization: "Bearer at-1" },
        method: "GET",
        url: USERINFO_URL,
      },
    ]);
  });

  test("maps email_verified only when it is literally boolean", async () => {
    expect(
      await userinfo(
        jsonResponse(200, {
          email: "ada@example.com",
          email_verified: "true",
          sub: "00u1federated",
        }),
      ).result,
    ).toStrictEqual({ emailClaims: { email: "ada@example.com" } });
  });

  test("refuses another subject's profile and unreadable responses", async () => {
    const signedJwt: FederationHttpResponse = {
      body: "header.payload.signature",
      headers: new Headers({ "content-type": "application/jwt" }),
      status: 200,
    };
    const outcomes = await Promise.all(
      [
        jsonResponse(200, { email: "eve@example.com", email_verified: true, sub: "00u1other" }),
        jsonResponse(200, { email: "ada@example.com", email_verified: true }),
        jsonResponse(200, { sub: 42 }),
        jsonResponse(401, { error: "invalid_token" }),
        jsonResponse(200, [{ sub: "00u1federated" }]),
        signedJwt,
      ].map((response) => failureCode(userinfo(response).result)),
    );
    expect(outcomes).toEqual([
      "userinfo_subject_mismatch",
      "userinfo_failed",
      "userinfo_failed",
      "userinfo_failed",
      "userinfo_failed",
      "userinfo_failed",
    ]);
  });
});
