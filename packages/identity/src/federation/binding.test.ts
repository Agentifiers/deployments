import { describe, expect, test } from "bun:test";

import { federationAuthorizationUrl, federationBinding } from "./binding.ts";
import { connection } from "./testing/fake-identity-provider.ts";

const binding = federationBinding("federation-binding-test-token");

describe("federationBinding", () => {
  test("derives a separate SHA-256 value per label, an S256 challenge and an xs:ID request ID", () => {
    expect(binding).toEqual({
      codeChallenge: "1ytDK6MClxsCH0Gz6Fr5uRMlkJfnX5d8hkYsbD-5BWI",
      codeVerifier: "nZLoTAappYosvsM3LqHud4MZG3hjHcSUtvHm2oBc2uU",
      lookupHash: "-sAeWpNJgVDWaX6uKop38ID3WrjdFnn0Y_6bbMr6igo",
      nonce: "ez98YQNIjxMEy_wuFwUbss9Ey6dA7veM5qyqdDg7pUw",
      samlRequestId: "_afqXXuhwkzDD9Ppzbr1KTH-SdpDAu050iJV9X_IJ2Rg",
      state: "A1MmTNk0JMRgbNa6AmV1QScPlaJpp8Sh7GcO1EPhVC8",
    });
  });
});

describe("federationAuthorizationUrl", () => {
  const withQuery = {
    ...connection,
    endpoints: {
      ...connection.endpoints,
      authorization: "https://idp.example.test/tenant/authorize?p=b2c_signin",
    },
  };

  test("builds a PKCE code-flow request and keeps the endpoint's own query", () => {
    expect(federationAuthorizationUrl({ binding, connection: withQuery, forceLogin: false })).toBe(
      "https://idp.example.test/tenant/authorize?p=b2c_signin&response_type=code&scope=openid+email+profile&client_id=client-123&redirect_uri=https%3A%2F%2Fauth.deployments.test%2Foauth2%2Ffederation%2Fcallback%2F01J8ORGANIZATION&state=A1MmTNk0JMRgbNa6AmV1QScPlaJpp8Sh7GcO1EPhVC8&nonce=ez98YQNIjxMEy_wuFwUbss9Ey6dA7veM5qyqdDg7pUw&code_challenge=1ytDK6MClxsCH0Gz6Fr5uRMlkJfnX5d8hkYsbD-5BWI&code_challenge_method=S256",
    );
  });

  test("adds the login hint and forces reauthentication on request", () => {
    const url = federationAuthorizationUrl({
      binding,
      connection,
      forceLogin: true,
      loginHint: "ada+1@example.com",
    });
    expect(url.slice(url.indexOf("&code_challenge_method"))).toBe(
      "&code_challenge_method=S256&login_hint=ada%2B1%40example.com&prompt=login&max_age=0",
    );
  });
});
