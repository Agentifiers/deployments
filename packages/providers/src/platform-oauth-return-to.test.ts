import { describe, expect, test } from "bun:test";
import {
  PlatformOAuthReturnToError,
  platformOAuthReturnOrigins,
  platformOAuthReturnTo,
} from "./platform-oauth-return-to.ts";

const ALLOWED = ["https://app.example.com", "https://console.example.com:8443"] as const;

describe("platformOAuthReturnTo", () => {
  for (const [value, normalized] of [
    ["https://app.example.com", "https://app.example.com/"],
    [
      "https://app.example.com/settings/connections?tab=apps",
      "https://app.example.com/settings/connections?tab=apps",
    ],
    ["https://APP.example.com:443/x", "https://app.example.com/x"],
    ["https://console.example.com:8443/done", "https://console.example.com:8443/done"],
  ] as const) {
    test(`accepts ${value}`, () => {
      expect(platformOAuthReturnTo(value, ALLOWED)).toBe(normalized);
    });
  }

  for (const value of [
    "/connections",
    "//app.example.com/x",
    "http://app.example.com/x",
    "javascript:alert(1)",
    "https:app.example.com/x",
    "https://app.example.com\\@evil.example/x",
    "https://app.example.com/x#frag",
    "https://app.example.com/#",
    "https://user:secret@app.example.com/x",
    "https://user@app.example.com/x",
    "https://app.example.com.evil.example/x",
    "https://evil.example/?next=https://app.example.com",
    "https://console.example.com/x",
    " https://app.example.com/x",
    "https://app.example.com/x\n",
    `https://app.example.com/${"a".repeat(2_048)}`,
  ]) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      expect(() => platformOAuthReturnTo(value, ALLOWED)).toThrow(PlatformOAuthReturnToError);
    });
  }

  test("rejects everything with an empty allowlist", () => {
    expect(() => platformOAuthReturnTo("https://app.example.com/x", [])).toThrow(
      PlatformOAuthReturnToError,
    );
  });
});

describe("platformOAuthReturnOrigins", () => {
  test("parses comma-separated exact origins and treats empty as no redirects", () => {
    expect(platformOAuthReturnOrigins(undefined)).toEqual([]);
    expect(platformOAuthReturnOrigins(" ")).toEqual([]);
    expect(
      platformOAuthReturnOrigins(" https://app.example.com, https://console.example.com:8443,"),
    ).toEqual(["https://app.example.com", "https://console.example.com:8443"]);
  });

  for (const value of [
    "http://app.example.com",
    "https://app.example.com/",
    "https://app.example.com/path",
    "https://APP.example.com",
    "app.example.com",
  ]) {
    test(`rejects ${value}`, () => {
      expect(() => platformOAuthReturnOrigins(value)).toThrow("PLATFORM_OAUTH_RETURN_ORIGINS");
    });
  }
});
