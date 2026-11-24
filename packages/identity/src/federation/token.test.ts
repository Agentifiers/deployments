import { describe, expect, test } from "bun:test";

import type { FederationConnection } from "./discovery.ts";
import { FederationError } from "./errors.ts";
import type { FederationHttpResponse } from "./http.ts";
import {
  connection,
  failureCode,
  jsonResponse,
  recordingHttp,
} from "./testing/fake-identity-provider.ts";
import { exchangeFederationCode } from "./token.ts";

const awkwardClient: FederationConnection = {
  ...connection,
  clientId: "client id+1",
  clientSecret: "s3cr~t:/ é",
};

function exchange(response: FederationHttpResponse, client: FederationConnection = connection) {
  const idp = recordingHttp(() => response);
  const result = exchangeFederationCode({
    code: "auth-code/1",
    codeVerifier: "nZLoTAappYosvsM3LqHud4MZG3hjHcSUtvHm2oBc2uU",
    connection: client,
    http: idp.http,
  });
  return { requests: idp.requests, result };
}

describe("exchangeFederationCode", () => {
  test("client_secret_basic form-urlencodes the credentials into the Authorization header", async () => {
    const { requests, result } = exchange(
      jsonResponse(200, { access_token: "at", id_token: "header.payload.signature" }),
      awkwardClient,
    );
    expect(await result).toStrictEqual({ idToken: "header.payload.signature" });
    expect(requests).toEqual([
      {
        body: "grant_type=authorization_code&code=auth-code%2F1&redirect_uri=https%3A%2F%2Fauth.deployments.test%2Foauth2%2Ffederation%2Fcallback%2F01J8ORGANIZATION&code_verifier=nZLoTAappYosvsM3LqHud4MZG3hjHcSUtvHm2oBc2uU",
        headers: {
          accept: "application/json",
          authorization: "Basic Y2xpZW50K2lkJTJCMTpzM2NyJTdFdCUzQSUyRislQzMlQTk=",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        url: "https://idp.example.test/tenant/token",
      },
    ]);
  });

  test("client_secret_post sends the credentials in the form body", async () => {
    const { requests, result } = exchange(jsonResponse(200, { id_token: "a.b.c" }), {
      ...awkwardClient,
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(await result).toEqual({ idToken: "a.b.c" });
    expect(requests).toEqual([
      {
        body: "grant_type=authorization_code&code=auth-code%2F1&redirect_uri=https%3A%2F%2Fauth.deployments.test%2Foauth2%2Ffederation%2Fcallback%2F01J8ORGANIZATION&code_verifier=nZLoTAappYosvsM3LqHud4MZG3hjHcSUtvHm2oBc2uU&client_id=client+id%2B1&client_secret=s3cr%7Et%3A%2F+%C3%A9",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        url: "https://idp.example.test/tenant/token",
      },
    ]);
  });

  test("a provider error fails without its description and is not retried", async () => {
    const description = "AADSTS7000215: Invalid client secret provided for tenant contoso";
    const { requests, result } = exchange(
      jsonResponse(400, { error: "invalid_client", error_description: description }),
    );
    const error = await result.catch((caught: unknown) => caught);
    expect(
      error instanceof FederationError && {
        code: error.code,
        leaksDescription: `${error.message} ${String(error.cause)}`.includes("AADSTS"),
        requests: requests.length,
      },
    ).toEqual({ code: "token_exchange_failed", leaksDescription: false, requests: 1 });
  });

  test("surfaces the access token only when the provider issued it as a Bearer token", async () => {
    const tokens = (response: Record<string, unknown>) =>
      exchange(jsonResponse(200, { id_token: "header.payload.signature", ...response })).result;
    expect(
      await Promise.all([
        tokens({ access_token: "at-1", token_type: "Bearer" }),
        tokens({ access_token: "at-2", token_type: "bearer" }),
        tokens({ access_token: "at-3", token_type: "DPoP" }),
        tokens({ access_token: "at-4" }),
        tokens({ access_token: "", token_type: "Bearer" }),
        tokens({ access_token: 42, token_type: "Bearer" }),
      ]),
    ).toStrictEqual([
      { bearerAccessToken: "at-1", idToken: "header.payload.signature" },
      { bearerAccessToken: "at-2", idToken: "header.payload.signature" },
      { idToken: "header.payload.signature" },
      { idToken: "header.payload.signature" },
      { idToken: "header.payload.signature" },
      { idToken: "header.payload.signature" },
    ]);
  });

  test("rejects redirects and responses without an ID token", async () => {
    const redirect: FederationHttpResponse = {
      body: "",
      headers: new Headers({ location: "https://idp.example.test/elsewhere" }),
      status: 302,
    };
    const outcomes = await Promise.all(
      [
        redirect,
        jsonResponse(200, { access_token: "at" }),
        jsonResponse(200, { id_token: "" }),
        jsonResponse(200, { id_token: 7 }),
        jsonResponse(201, { id_token: "a.b.c" }),
      ].map((response) => failureCode(exchange(response).result)),
    );
    expect(outcomes).toEqual(Array(5).fill("token_exchange_failed"));
  });
});
