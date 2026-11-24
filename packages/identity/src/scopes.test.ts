import { describe, expect, test } from "bun:test";
import { credentialScopePermits, platformScopePermits } from "./scopes.ts";

describe("scope grants", () => {
  test("a wildcard grants apps:publish to a person but never to a credential", () => {
    const grants = [
      ["apps:*"],
      ["platform:*"],
      ["platform:admin"],
      ["apps:publish"],
      ["apps:read"],
    ];

    expect(
      grants.map((granted) => [
        granted[0],
        platformScopePermits(granted, "apps:publish"),
        credentialScopePermits(granted, "apps:publish"),
        credentialScopePermits(granted, "apps:read"),
      ]),
    ).toEqual([
      ["apps:*", true, false, true],
      ["platform:*", true, false, true],
      ["platform:admin", true, false, true],
      ["apps:publish", true, true, false],
      ["apps:read", false, false, true],
    ]);
  });
});
