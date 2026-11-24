import { describe, expect, test } from "bun:test";

import {
  credentialValuesWithProviderOAuthMaterial,
  providerOAuthMaterialFromCredentialValues,
} from "./provider-oauth-material.ts";

describe("provider OAuth material in credential values", () => {
  test("round-trips encrypted runtime material without exposing it as provider fields", () => {
    const stored = credentialValuesWithProviderOAuthMaterial(
      { accessToken: "access-token" },
      {
        requestHeaders: { "Developer-Token": "developer-secret" },
        resource: "https://example.my.salesforce.com/",
      },
    );

    expect(providerOAuthMaterialFromCredentialValues(stored)).toEqual({
      fields: { accessToken: "access-token" },
      requestHeaders: { "developer-token": "developer-secret" },
      resource: "https://example.my.salesforce.com",
    });
  });

  test("rejects malformed stored runtime material", () => {
    expect(() =>
      providerOAuthMaterialFromCredentialValues({
        accessToken: "access-token",
        "deploymentsAi.providerRequestHeaders": '{"bad header":"secret"}',
      }),
    ).toThrow("invalid name or value");
  });
});
