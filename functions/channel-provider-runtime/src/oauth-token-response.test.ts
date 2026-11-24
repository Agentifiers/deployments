import { describe, expect, test } from "bun:test";
import {
  assertRotatedRefreshToken,
  oauthRefreshResource,
  oauthTokenFetchInit,
  parseOAuthTokenEndpointResponse,
} from "./oauth-token-response.ts";

describe("OAuth token responses", () => {
  test("rejects redirects while sending token exchange credentials", () => {
    expect(
      oauthTokenFetchInit({
        body: "grant_type=authorization_code&client_secret=secret",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    ).toEqual({
      body: "grant_type=authorization_code&client_secret=secret",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "error",
    });
  });

  test("requires configured refresh rotation to return the replacement token", () => {
    expect(() =>
      assertRotatedRefreshToken({ refreshTokenRotationRequired: true }, "current-token", undefined),
    ).toThrow("required rotated refresh token");
    expect(() =>
      assertRotatedRefreshToken(
        { refreshTokenRotationRequired: true },
        "current-token",
        "current-token",
      ),
    ).toThrow("required rotated refresh token");
    expect(() =>
      assertRotatedRefreshToken(
        { refreshTokenRotationRequired: true },
        "current-token",
        "rotated-token",
      ),
    ).not.toThrow();
    expect(() =>
      assertRotatedRefreshToken(
        { refreshTokenRotationRequired: false },
        "current-token",
        undefined,
      ),
    ).not.toThrow();
  });

  test("rejects refresh responses that substitute the bound resource", () => {
    expect(oauthRefreshResource("https://expected.example", undefined)).toBe(
      "https://expected.example",
    );
    expect(() =>
      oauthRefreshResource("https://expected.example", "https://different.example"),
    ).toThrow("different resource binding");
  });

  test("classifies errors before decoding and bounds successful token bodies", async () => {
    expect(
      parseOAuthTokenEndpointResponse(new Response("not-json", { status: 401 })),
    ).rejects.toThrow("returned HTTP 401");
    expect(
      parseOAuthTokenEndpointResponse(
        new Response(JSON.stringify({ access_token: "x".repeat(70_000) }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow("maximum of 65536 bytes");
  });
});
