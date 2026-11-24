import { describe, expect, test } from "bun:test";
import { beginAuthorization, callbackBindingIsValid, safePostLoginPath } from "./authorization.ts";

const ORIGIN = "https://console.test";

describe("post-login path", () => {
  test.each([
    ["/orgs/1?tab=a", "/orgs/1?tab=a"],
    ["https://console.test/orgs#frag", "/orgs"],
    ["https://console.test", "/"],
    ["//evil.test/path", "/"],
    ["https://evil.test/orgs", "/"],
    ["https://console.test.evil.test/", "/"],
    ["javascript:alert(1)", "/"],
    ["/\\evil.test", "/"],
    ["orgs", "/"],
    ["/auth/logout", "/"],
    ["/auth", "/"],
    ["/authors", "/authors"],
  ])("%s → %s", (input, expected) => {
    expect(safePostLoginPath(input, ORIGIN)).toBe(expected);
  });
});

describe("callback binding", () => {
  const begun = beginAuthorization({
    expiresAt: "2026-10-01T12:10:00.000Z",
    postLoginPath: "//evil.test/path",
    redirectUri: `${ORIGIN}/auth/callback`,
    scopes: ["openid", "offline_access", "openid"],
  });
  const valid = {
    binding: begun.binding,
    callbackIssuer: "https://auth.test",
    callbackState: begun.authorizationParameters.state,
    configuredIssuer: "https://auth.test",
    now: new Date("2026-10-01T12:01:00.000Z"),
    redirectUri: `${ORIGIN}/auth/callback`,
    transactionCookie: begun.transactionCookie,
  };

  test("generates independent values and stores only hashes", () => {
    const values = [
      begun.transactionCookie,
      begun.authorizationParameters.state,
      begun.authorizationParameters.nonce,
      begun.protectedState.pkceVerifier,
    ];
    expect(new Set(values).size).toBe(4);
    expect(JSON.stringify(begun.binding)).not.toContain(begun.authorizationParameters.state!);
    expect(begun.authorizationParameters.scope).toBe("offline_access openid");
    expect(begun.protectedState.postLoginPath).toBe("/");
  });

  test("accepts only the exact binding", () => {
    expect(callbackBindingIsValid(valid)).toBe(true);
    expect(callbackBindingIsValid({ ...valid, callbackIssuer: undefined })).toBe(false);
    expect(callbackBindingIsValid({ ...valid, callbackIssuer: "https://auth.test/" })).toBe(false);
    expect(callbackBindingIsValid({ ...valid, callbackState: "other" })).toBe(false);
    expect(callbackBindingIsValid({ ...valid, transactionCookie: undefined })).toBe(false);
    expect(callbackBindingIsValid({ ...valid, redirectUri: `${ORIGIN}/other` })).toBe(false);
    expect(callbackBindingIsValid({ ...valid, now: new Date("2026-10-01T12:10:00.000Z") })).toBe(
      false,
    );
    expect(
      callbackBindingIsValid({ ...valid, binding: { ...begun.binding, status: "consumed" } }),
    ).toBe(false);
  });
});

describe("authorization parameters", () => {
  const input = {
    expiresAt: "2026-10-01T12:10:00.000Z",
    postLoginPath: "/",
    redirectUri: `${ORIGIN}/auth/callback`,
    scopes: ["openid"],
  };

  test("sends prompt=login only when requested", () => {
    expect(beginAuthorization({ ...input, prompt: "login" }).authorizationParameters.prompt).toBe(
      "login",
    );
    expect(beginAuthorization(input).authorizationParameters.prompt).toBeUndefined();
  });
});
