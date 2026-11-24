import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { decodeRequestBody } from "./request-body.ts";

function problemOf(body: unknown) {
  try {
    decodeRequestBody("createProviderApplication", "CreateProviderApplicationRequest", body);
  } catch (error) {
    if (error instanceof PlatformApiError) return error.problem;
    throw error;
  }
  return undefined;
}

describe("decodeRequestBody", () => {
  test("names a rejected client secret without echoing it", () => {
    expect(
      problemOf({
        clientId: "qa-client",
        clientSecret: "SUPER-SECRET-VALUE\n",
        displayName: "QA github",
        providerKey: "github",
        redirectUris: [],
        requestedScopes: [],
      }),
    ).toEqual({
      detail: "The request has an invalid value at clientSecret.",
      status: 400,
      title: "Invalid request",
    });
  });

  test("returns a body the contract accepts", () => {
    expect(
      decodeRequestBody("createProviderApplication", "CreateProviderApplicationRequest", {
        clientId: "qa-client",
        displayName: "QA github",
        providerKey: "github",
        redirectUris: [],
        requestedScopes: [],
      }),
    ).toEqual({
      clientId: "qa-client",
      displayName: "QA github",
      providerKey: "github",
      redirectUris: [],
      requestedScopes: [],
    });
  });
});
