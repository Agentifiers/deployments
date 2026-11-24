import { describe, expect, test } from "bun:test";

import { discoverProvider } from "./discovery.ts";
import type { FederationHttpResponse } from "./http.ts";
import { failureCode, jsonResponse, recordingHttp } from "./testing/fake-identity-provider.ts";

const ISSUER = "https://accounts.example.test";

function document(overrides: Record<string, unknown> = {}) {
  return {
    authorization_endpoint: "https://accounts.example.test/o/oauth2/v2/auth",
    id_token_signing_alg_values_supported: ["RS256"],
    issuer: ISSUER,
    jwks_uri: "https://www.example-apis.test/oauth2/v3/certs",
    response_types_supported: ["code", "token", "id_token"],
    token_endpoint: "https://oauth2.example-apis.test/token",
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    ...overrides,
  };
}

function discover(issuer: string, response: FederationHttpResponse) {
  const idp = recordingHttp(() => response);
  return { requests: idp.requests, result: discoverProvider({ http: idp.http, issuer }) };
}

function outcome(overrides: Record<string, unknown>) {
  return failureCode(discover(ISSUER, jsonResponse(200, document(overrides))).result);
}

function discovered(overrides: Record<string, unknown>) {
  return discover(ISSUER, jsonResponse(200, document(overrides))).result;
}

describe("discoverProvider", () => {
  test("returns the provider snapshot from the well-known document", async () => {
    const { requests, result } = discover(ISSUER, jsonResponse(200, document()));
    expect(await result).toEqual({
      endpoints: {
        authorization: "https://accounts.example.test/o/oauth2/v2/auth",
        jwks: "https://www.example-apis.test/oauth2/v3/certs",
        token: "https://oauth2.example-apis.test/token",
      },
      issuer: ISSUER,
      signingAlgorithms: ["RS256"],
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    expect(requests).toEqual([
      {
        headers: { accept: "application/json" },
        method: "GET",
        url: "https://accounts.example.test/.well-known/openid-configuration",
      },
    ]);
  });

  test("strips one trailing slash before appending the well-known path, and keeps the issuer exact", async () => {
    const issuer = "https://login.example.test/tenant/v2.0/";
    const { requests, result } = discover(issuer, jsonResponse(200, document({ issuer })));
    expect((await result).issuer).toBe("https://login.example.test/tenant/v2.0/");
    expect(requests.map((request) => request.url)).toEqual([
      "https://login.example.test/tenant/v2.0/.well-known/openid-configuration",
    ]);
  });

  test("rejects a multi-tenant issuer whose document names a tenant issuer", async () => {
    const common = "https://login.microsoftonline.com/common/v2.0";
    const tenant = "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0";
    const { result } = discover(common, jsonResponse(200, document({ issuer: tenant })));
    expect(await failureCode(result)).toBe("discovery_issuer_mismatch");
  });

  test("rejects issuers that are not plain https URLs without fetching", async () => {
    const outcomes = await Promise.all(
      [
        "http://accounts.example.test",
        "https://accounts.example.test?tenant=1",
        "https://accounts.example.test#x",
        Object.assign(new URL("https://accounts.example.test"), { password: "p", username: "u" })
          .href,
        "accounts.example.test",
      ].map(async (issuer) => {
        const { requests, result } = discover(issuer, jsonResponse(200, document({ issuer })));
        return { code: await failureCode(result), requests: requests.length };
      }),
    );
    expect(outcomes).toEqual(Array(5).fill({ code: "issuer_invalid", requests: 0 }));
  });

  test("rejects redirects, errors, and non-JSON bodies", async () => {
    const redirect: FederationHttpResponse = {
      body: "",
      headers: new Headers({
        location: "https://evil.example.test/.well-known/openid-configuration",
      }),
      status: 302,
    };
    const html: FederationHttpResponse = { body: "<html>", headers: new Headers(), status: 200 };
    const outcomes = await Promise.all(
      [
        redirect,
        jsonResponse(404, document()),
        html,
        jsonResponse(200, ["not", "an", "object"]),
      ].map((response) => failureCode(discover(ISSUER, response).result)),
    );
    expect(outcomes).toEqual(Array(4).fill("discovery_failed"));
  });

  test("requires https endpoints and the authorization code flow", async () => {
    expect([
      await outcome({ token_endpoint: "http://oauth2.example-apis.test/token" }),
      await outcome({ jwks_uri: "http://www.example-apis.test/certs" }),
      await outcome({ authorization_endpoint: "javascript:alert(1)" }),
      await outcome({ token_endpoint: undefined }),
      await outcome({ response_types_supported: ["id_token", "token id_token"] }),
      await outcome({ response_types_supported: undefined }),
    ]).toEqual([
      "discovery_insecure_endpoint",
      "discovery_insecure_endpoint",
      "discovery_insecure_endpoint",
      "discovery_failed",
      "discovery_code_flow_unsupported",
      "discovery_code_flow_unsupported",
    ]);
  });

  test("keeps an https userinfo endpoint when the provider advertises one", async () => {
    const advertised = await discovered({
      userinfo_endpoint: "https://accounts.example.test/oauth2/v1/userinfo",
    });
    const silent = await discovered({});
    expect([advertised.endpoints, silent.endpoints]).toStrictEqual([
      {
        authorization: "https://accounts.example.test/o/oauth2/v2/auth",
        jwks: "https://www.example-apis.test/oauth2/v3/certs",
        token: "https://oauth2.example-apis.test/token",
        userinfo: "https://accounts.example.test/oauth2/v1/userinfo",
      },
      {
        authorization: "https://accounts.example.test/o/oauth2/v2/auth",
        jwks: "https://www.example-apis.test/oauth2/v3/certs",
        token: "https://oauth2.example-apis.test/token",
      },
    ]);
    expect([
      await outcome({ userinfo_endpoint: "http://accounts.example.test/oauth2/v1/userinfo" }),
      await outcome({ userinfo_endpoint: 443 }),
    ]).toEqual(["discovery_insecure_endpoint", "discovery_failed"]);
  });

  test("intersects signing algorithms with RS256, PS256, and ES256", async () => {
    const algorithms = async (advertised: unknown) =>
      (await discovered({ id_token_signing_alg_values_supported: advertised })).signingAlgorithms;
    expect([
      await algorithms(["HS256", "ES256", "none", "EdDSA", "RS256"]),
      await algorithms(["PS256"]),
      await algorithms(undefined),
    ]).toEqual([["RS256", "ES256"], ["PS256"], ["RS256"]]);
    expect(await outcome({ id_token_signing_alg_values_supported: ["HS256", "EdDSA"] })).toBe(
      "discovery_signing_algorithm_unsupported",
    );
  });

  test("prefers client_secret_basic, falls back to client_secret_post", async () => {
    const method = async (advertised: unknown) =>
      (await discovered({ token_endpoint_auth_methods_supported: advertised }))
        .tokenEndpointAuthMethod;
    expect([
      await method(undefined),
      await method(["client_secret_post", "client_secret_basic"]),
      await method(["private_key_jwt", "client_secret_post"]),
    ]).toEqual(["client_secret_basic", "client_secret_basic", "client_secret_post"]);
    expect([
      await outcome({ token_endpoint_auth_methods_supported: ["private_key_jwt"] }),
      await outcome({ token_endpoint_auth_methods_supported: "client_secret_basic" }),
    ]).toEqual(["discovery_client_auth_unsupported", "discovery_failed"]);
  });
});
