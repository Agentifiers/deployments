import { describe, expect, test } from "bun:test";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import {
  deviceAuthorizationAudienceIsCompatible,
  deviceAuthorizationProfile,
} from "./device-authorization-profile.ts";

describe("device authorization provider profiles", () => {
  test("uses platform access tokens and scopes only after the identity cutover", () => {
    expect(deviceAuthorizationProfile("platform")).toEqual({
      bearerTokenSource: "access_token",
      scopes: PLATFORM_CLI_SCOPES,
    });
  });

  test("the CLI asks for apps:publish so a member can change an app's publication", () => {
    const appScopes = deviceAuthorizationProfile("platform").scopes?.filter((scope) =>
      scope.startsWith("apps:"),
    );

    expect(appScopes).toEqual(["apps:publish", "apps:read", "apps:write"]);
  });

  test("preserves ID-token bearers for every legacy claim profile", () => {
    for (const claimProfile of ["cognito", "legacy", undefined] as const) {
      expect(deviceAuthorizationProfile(claimProfile)).toEqual({
        bearerTokenSource: "id_token",
      });
    }
  });

  test("requires only ID-token profiles to use a client ID accepted as an audience", () => {
    expect(
      deviceAuthorizationAudienceIsCompatible(
        deviceAuthorizationProfile("platform"),
        "deployments-api",
        "deployments-cli",
      ),
    ).toBeTrue();
    expect(
      deviceAuthorizationAudienceIsCompatible(
        deviceAuthorizationProfile("legacy"),
        "deployments-api",
        "deployments-cli",
      ),
    ).toBeFalse();
    expect(
      deviceAuthorizationAudienceIsCompatible(
        deviceAuthorizationProfile("cognito"),
        ["deployments-api", "deployments-cli"],
        "deployments-cli",
      ),
    ).toBeTrue();
  });
});
